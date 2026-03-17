import { useEffect, useMemo, useRef, useState } from "react";

function resolveWebSocketUrl() {
  if (import.meta.env.VITE_WS_URL) {
    return import.meta.env.VITE_WS_URL;
  }

  if (import.meta.env.VITE_ALERT_WS_URL) {
    return import.meta.env.VITE_ALERT_WS_URL;
  }

  return `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws/alerts`;
}

const WS_URL = resolveWebSocketUrl();
const CONNECT_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 20000;
const HEARTBEAT_TIMEOUT_MS = 30000;
const INITIAL_RECONNECT_MS = 2000;
const MAX_RECONNECT_MS = 15000;
const MAX_SIGNAL_HISTORY = 250;

function toSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

function buildCanonicalPostUrl({ subreddit, postId, title }) {
  const safeSub = String(subreddit || "all").replace(/^r\//i, "").trim() || "all";
  const safeId = String(postId || "").trim() || "unknown";
  const slug = toSlug(title) || "post";
  return `https://reddit.com/r/${safeSub}/comments/${safeId}/${slug}/`;
}

function buildSubredditUrl(subreddit) {
  const safeSub = String(subreddit || "all").replace(/^r\//i, "").trim() || "all";
  return `https://reddit.com/r/${safeSub}/`;
}

function normalizePostUrl(postUrlCandidate, fallback, subredditFallback) {
  if (postUrlCandidate) {
    try {
      const parsed = new URL(postUrlCandidate, "https://reddit.com");
      const host = parsed.hostname.toLowerCase();
      const isRedditHost =
        host === "reddit.com" ||
        host === "www.reddit.com" ||
        host.endsWith(".reddit.com");
      const hasCommentsPath = parsed.pathname.includes("/comments/");
      if (isRedditHost && hasCommentsPath) {
        return `https://reddit.com${parsed.pathname}${parsed.search}${parsed.hash}`;
      }

      if (isRedditHost) {
        return subredditFallback;
      }
    } catch {
      // fall through to canonical fallback
    }
  }

  return fallback;
}

function normalizeSignal(signal) {
  const post = signal?.post || {};
  const fallbackId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const postId = post.id || fallbackId;
  const canonicalPostUrl = buildCanonicalPostUrl({
    subreddit: post.subreddit,
    postId,
    title: post.title,
  });
  const subredditUrl = buildSubredditUrl(post.subreddit);

  const postUrl = normalizePostUrl(
    post.post_url || post.permalink,
    canonicalPostUrl,
    subredditUrl
  );

  return {
    id: signal?.signal_id || fallbackId,
    postId,
    title: post.title || "Untitled post",
    subreddit: String(post.subreddit || "unknown").toLowerCase(),
    username: post.author || post.username || "unknown",
    upvotes: post.upvotes ?? 0,
    comments: post.comment_count ?? 0,
    image: post.image || post.thumbnail_url || null,
    link: post.article_link || postUrl,
    post_url: postUrl,
    timestamp: post.timestamp || new Date().toISOString(),
    signalScore: signal?.signal_score ?? 0,
    reasons: Array.isArray(signal?.reasons) ? signal.reasons : [],
  };
}

export function useSignalStream() {
  const [signals, setSignals] = useState([]);
  const [streamError, setStreamError] = useState("");

  const socketRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const heartbeatTimerRef = useRef(null);
  const heartbeatTimeoutRef = useRef(null);
  const connectTimeoutRef = useRef(null);
  const isUnmountedRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const signalIdsRef = useRef(new Set());

  const connectSocket = useMemo(() => {
    const clearSocketTimers = () => {
      if (heartbeatTimerRef.current) {
        window.clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
      if (heartbeatTimeoutRef.current) {
        window.clearTimeout(heartbeatTimeoutRef.current);
        heartbeatTimeoutRef.current = null;
      }
      if (connectTimeoutRef.current) {
        window.clearTimeout(connectTimeoutRef.current);
        connectTimeoutRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      if (isUnmountedRef.current) {
        return;
      }

      const delay = Math.min(
        INITIAL_RECONNECT_MS * (2 ** reconnectAttemptRef.current),
        MAX_RECONNECT_MS
      );
      reconnectAttemptRef.current += 1;
      if (reconnectAttemptRef.current >= 3) {
        setStreamError("Signal stream temporarily unavailable.");
      }
      reconnectTimerRef.current = window.setTimeout(openSocket, delay);
    };

    const openSocket = () => {
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      clearSocketTimers();
      const socket = new WebSocket(WS_URL);
      socketRef.current = socket;

      connectTimeoutRef.current = window.setTimeout(() => {
        if (socket.readyState !== WebSocket.OPEN) {
          socket.close();
        }
      }, CONNECT_TIMEOUT_MS);

      socket.onopen = () => {
        reconnectAttemptRef.current = 0;
        setStreamError("");
        if (connectTimeoutRef.current) {
          window.clearTimeout(connectTimeoutRef.current);
          connectTimeoutRef.current = null;
        }

        const resetHeartbeatTimeout = () => {
          if (heartbeatTimeoutRef.current) {
            window.clearTimeout(heartbeatTimeoutRef.current);
          }
          heartbeatTimeoutRef.current = window.setTimeout(() => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.close();
            }
          }, HEARTBEAT_TIMEOUT_MS);
        };

        resetHeartbeatTimeout();
        heartbeatTimerRef.current = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send("ping");
            resetHeartbeatTimeout();
          }
        }, HEARTBEAT_MS);
      };

      socket.onerror = () => {
        // Allow onclose to drive reconnect scheduling.
      };

      socket.onclose = () => {
        if (socketRef.current === socket) {
          socketRef.current = null;
        }
        clearSocketTimers();

        if (!isUnmountedRef.current) {
          scheduleReconnect();
        }
      };

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message?.type === "hello") {
            setStreamError("");
            return;
          }
          if (message?.type === "pong") {
            if (heartbeatTimeoutRef.current) {
              window.clearTimeout(heartbeatTimeoutRef.current);
            }
            heartbeatTimeoutRef.current = window.setTimeout(() => {
              if (socket.readyState === WebSocket.OPEN) {
                socket.close();
              }
            }, HEARTBEAT_TIMEOUT_MS);
            return;
          }
          if (message?.type !== "signal" || !message?.payload) {
            return;
          }

          const nextSignal = normalizeSignal(message.payload);
          if (signalIdsRef.current.has(nextSignal.id)) {
            return;
          }

          setStreamError("");
          signalIdsRef.current.add(nextSignal.id);
          setSignals((current) => {
            const next = [nextSignal, ...current];
            if (next.length <= MAX_SIGNAL_HISTORY) {
              return next;
            }

            const trimmed = next.slice(0, MAX_SIGNAL_HISTORY);
            signalIdsRef.current = new Set(trimmed.map((item) => item.id));
            return trimmed;
          });
        } catch {
          setStreamError("Signal stream temporarily unavailable.");
        }
      };
    };

    return openSocket;
  }, []);

  useEffect(() => {
    isUnmountedRef.current = false;
    connectSocket();

    return () => {
      isUnmountedRef.current = true;

      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (heartbeatTimerRef.current) {
        window.clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
      if (heartbeatTimeoutRef.current) {
        window.clearTimeout(heartbeatTimeoutRef.current);
        heartbeatTimeoutRef.current = null;
      }
      if (connectTimeoutRef.current) {
        window.clearTimeout(connectTimeoutRef.current);
        connectTimeoutRef.current = null;
      }

      const socket = socketRef.current;
      if (socket && socket.readyState < WebSocket.CLOSING) {
        socket.close();
      }
      socketRef.current = null;
    };
  }, [connectSocket]);

  return {
    signals,
    streamError,
  };
}
