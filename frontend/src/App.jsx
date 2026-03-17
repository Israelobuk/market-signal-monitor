import Sidebar from "./components/Sidebar";
import ActiveAlert from "./components/ActiveAlert";
import SignalFeed from "./components/SignalFeed";
import { useEffect, useMemo, useRef, useState } from "react";

function resolveBackendBaseUrl() {
  if (import.meta.env.VITE_API_BASE_URL) {
    return import.meta.env.VITE_API_BASE_URL;
  }
  const isLocalDev = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  if (isLocalDev) {
    return `${window.location.protocol}//${window.location.hostname}:8000`;
  }
  return `${window.location.protocol}//${window.location.host}`;
}

function resolveWebSocketUrl() {
  if (import.meta.env.VITE_WS_URL) {
    return import.meta.env.VITE_WS_URL;
  }

  if (import.meta.env.VITE_ALERT_WS_URL) {
    return import.meta.env.VITE_ALERT_WS_URL;
  }
  const isLocalDev = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  if (isLocalDev) {
    return `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:8000/ws/alerts`;
  }
  return `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws/alerts`;
}

const API_BASE_URL = resolveBackendBaseUrl();
const WS_URL = resolveWebSocketUrl();
const WATCHLIST_URL = import.meta.env.VITE_WATCHLIST_URL || `${API_BASE_URL}/api/watchlist`;
const ASSISTANT_CHAT_URL = `${API_BASE_URL}/api/assistant/chat`;
const LATEST_SIGNALS_URL = `${API_BASE_URL}/api/signals/latest`;
const ACTIVE_ALERT_MS = 6200;
const CONNECT_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 20000;
const HEARTBEAT_TIMEOUT_MS = 30000;
const INITIAL_RECONNECT_MS = 2000;
const MAX_RECONNECT_MS = 15000;
const MAX_WATCHLIST_SIZE = 20;
const DEFAULT_WATCHLIST = ["stocks", "investing", "economics", "cryptocurrency"];
const WATCHLIST_STORAGE_KEY = "signal-desk-watchlist";
const FILTER_STORAGE_KEY = "signal-desk-filters";
const FILTER_DEFAULTS = {
  timeRange: "all",
};

const TIME_RANGE_TO_MS = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

function normalizeWatchlist(values) {
  const normalized = [];
  const seen = new Set();

  for (const value of values) {
    const cleaned = String(value || "").trim().replace(/^r\//i, "").toLowerCase();
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    normalized.push(cleaned);
    if (normalized.length >= MAX_WATCHLIST_SIZE) {
      break;
    }
  }

  return normalized;
}

function loadStoredFilters() {
  if (typeof window === "undefined") {
    return { ...FILTER_DEFAULTS };
  }

  try {
    const raw = window.localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) {
      return { ...FILTER_DEFAULTS };
    }

    const parsed = JSON.parse(raw);
    return {
      ...FILTER_DEFAULTS,
      ...(parsed && typeof parsed === "object" ? parsed : {}),
    };
  } catch {
    return { ...FILTER_DEFAULTS };
  }
}

function loadStoredWatchlist() {
  if (typeof window === "undefined") {
    return [...DEFAULT_WATCHLIST];
  }

  try {
    const raw = window.localStorage.getItem(WATCHLIST_STORAGE_KEY);
    if (!raw) {
      return [...DEFAULT_WATCHLIST];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [...DEFAULT_WATCHLIST];
    }

    const normalized = normalizeWatchlist(parsed);
    return normalized.length > 0 ? normalized : [...DEFAULT_WATCHLIST];
  } catch {
    return [...DEFAULT_WATCHLIST];
  }
}

function sameList(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((item, index) => item === right[index]);
}

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

      if (!isRedditHost) {
        return parsed.toString();
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

function enrichAlert(alert) {
  return { ...alert };
}

function passesTimeRange(timestamp, selectedRange) {
  if (selectedRange === "all") {
    return true;
  }

  const maxAge = TIME_RANGE_TO_MS[selectedRange];
  const parsed = new Date(timestamp).getTime();
  if (!maxAge || Number.isNaN(parsed)) {
    return true;
  }

  return Date.now() - parsed <= maxAge;
}

function passesFilters(alert, filters) {
  return passesTimeRange(alert.timestamp, filters.timeRange);
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

  return enrichAlert({
    id: signal?.signal_id || fallbackId,
    postId,
    title: post.title || "Untitled post",
    bodyText: post.body_text || "",
    subreddit: post.subreddit || "unknown",
    username: post.author || post.username || "unknown",
    upvotes: post.upvotes ?? 0,
    comments: post.comment_count ?? 0,
    image: post.image || post.thumbnail_url || null,
    link: post.article_link || postUrl,
    post_url: postUrl,
    timestamp: post.timestamp || new Date().toISOString(),
    signalScore: signal?.signal_score ?? 0,
    reasons: Array.isArray(signal?.reasons) ? signal.reasons : [],
    aiSummary: post.ai_summary || "",
    aiSector: post.ai_sector || "",
    aiReason: post.ai_reason || "",
    aiConfidence: post.ai_confidence ?? 0,
    aiMarketRelevant:
      typeof post.ai_market_relevant === "boolean" ? post.ai_market_relevant : true,
    aiTickers: Array.isArray(post.ai_tickers) ? post.ai_tickers : [],
  });
}

function normalizePost(post) {
  const fallbackId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const postId = post?.id || fallbackId;
  const canonicalPostUrl = buildCanonicalPostUrl({
    subreddit: post?.subreddit,
    postId,
    title: post?.title,
  });
  const subredditUrl = buildSubredditUrl(post?.subreddit);
  const postUrl = normalizePostUrl(post?.post_url || post?.permalink, canonicalPostUrl, subredditUrl);

  return enrichAlert({
    id: postId,
    postId,
    title: post?.title || "Untitled post",
    bodyText: post?.body_text || "",
    subreddit: post?.subreddit || "unknown",
    username: post?.author || post?.username || "unknown",
    upvotes: post?.upvotes ?? 0,
    comments: post?.comment_count ?? post?.comments ?? 0,
    image: post?.image || post?.thumbnail_url || null,
    link: post?.article_link || postUrl,
    post_url: postUrl,
    timestamp: post?.timestamp || new Date().toISOString(),
    signalScore: post?.signal_score ?? 0,
    reasons: [],
    aiSummary: post?.ai_summary || "",
    aiSector: post?.ai_sector || "",
    aiReason: post?.ai_reason || "",
    aiConfidence: post?.ai_confidence ?? 0,
    aiMarketRelevant:
      typeof post?.ai_market_relevant === "boolean" ? post.ai_market_relevant : true,
    aiTickers: Array.isArray(post?.ai_tickers) ? post.ai_tickers : [],
  });
}

function buildSnapshotAlerts(posts) {
  if (!Array.isArray(posts)) {
    return [];
  }

  return posts
    .map((post) => normalizePost(post))
    .sort((left, right) => {
      const leftEngagement = (left.upvotes ?? 0) + (left.comments ?? 0);
      const rightEngagement = (right.upvotes ?? 0) + (right.comments ?? 0);

      if (rightEngagement !== leftEngagement) {
        return rightEngagement - leftEngagement;
      }

      return new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime();
    });
}

function upsertAlert(current, nextAlert) {
  const remaining = current.filter((item) => item.postId !== nextAlert.postId);
  return [nextAlert, ...remaining];
}

function mergeUniqueAlerts(...groups) {
  const merged = [];
  const seen = new Set();

  for (const group of groups) {
    for (const alert of group.filter(Boolean)) {
      if (seen.has(alert.postId)) {
        continue;
      }
      seen.add(alert.postId);
      merged.push(alert);
    }
  }

  return merged;
}

function excludeAlertIds(alerts, excludedIds) {
  return alerts.filter((alert) => !excludedIds.has(alert.postId));
}

function App() {
  const [alerts, setAlerts] = useState([]);
  const [recentAlerts, setRecentAlerts] = useState([]);
  const [activeAlert, setActiveAlert] = useState(null);
  const [queuedAlerts, setQueuedAlerts] = useState([]);
  const [justAddedId, setJustAddedId] = useState(null);
  const [streamError, setStreamError] = useState("");
  const [watchingSubreddits, setWatchingSubreddits] = useState(loadStoredWatchlist);
  const [filters, setFilters] = useState(loadStoredFilters);
  const [isAssistantOpen, setIsAssistantOpen] = useState(true);

  const socketRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const heartbeatTimerRef = useRef(null);
  const heartbeatTimeoutRef = useRef(null);
  const connectTimeoutRef = useRef(null);
  const clearHighlightTimerRef = useRef(null);
  const isUnmountedRef = useRef(false);
  const shouldReconnectRef = useRef(true);
  const seenIdsRef = useRef(new Set());
  const reconnectAttemptRef = useRef(0);
  const activeAlertRef = useRef(null);
  const queuedAlertsRef = useRef([]);
  const recentAlertsRef = useRef([]);

  useEffect(() => {
    activeAlertRef.current = activeAlert;
  }, [activeAlert]);

  useEffect(() => {
    queuedAlertsRef.current = queuedAlerts;
  }, [queuedAlerts]);

  useEffect(() => {
    recentAlertsRef.current = recentAlerts;
  }, [recentAlerts]);

  const connectSocket = useMemo(() => {
    const applySnapshotPosts = (posts) => {
      const snapshotAlerts = buildSnapshotAlerts(posts);
      const queued = queuedAlertsRef.current;
      const currentActive = activeAlertRef.current;
      const recent = recentAlertsRef.current;
      const queuedIds = new Set(queued.map((alert) => alert.postId));
      const recentIds = new Set(recent.map((alert) => alert.postId));
      const excludedIds = new Set([
        currentActive?.postId,
        ...queuedIds,
        ...recentIds,
      ].filter(Boolean));
      const availableSnapshotAlerts = excludeAlertIds(snapshotAlerts, excludedIds);

      if (!currentActive && queued.length === 0) {
        const [nextActive, ...remaining] = availableSnapshotAlerts;
        setActiveAlert(nextActive ?? null);
        setAlerts(remaining);
        return;
      }

      setAlerts((current) => mergeUniqueAlerts(current, availableSnapshotAlerts));
    };

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
      if (isUnmountedRef.current || !shouldReconnectRef.current) {
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

      shouldReconnectRef.current = true;
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

        if (!isUnmountedRef.current && shouldReconnectRef.current) {
          scheduleReconnect();
        }
      };

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message?.type === "hello") {
            if (heartbeatTimeoutRef.current) {
              window.clearTimeout(heartbeatTimeoutRef.current);
              heartbeatTimeoutRef.current = null;
            }
            applySnapshotPosts(message?.payload?.posts);
            setStreamError(String(message?.payload?.error || "").trim());
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
          if (message?.type === "watchlist_updated") {
            setJustAddedId(null);
            return;
          }
          if (message?.type === "posts_snapshot") {
            applySnapshotPosts(message?.payload?.posts);
            setStreamError(String(message?.payload?.error || "").trim());
            return;
          }
          if (message?.type !== "signal" || !message?.payload) {
            return;
          }

          const nextAlert = normalizeSignal(message.payload);
          if (seenIdsRef.current.has(nextAlert.id)) {
            return;
          }

          setStreamError("");
          seenIdsRef.current.add(nextAlert.id);
          setQueuedAlerts((current) => [...current, nextAlert]);
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
      shouldReconnectRef.current = false;

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
      if (clearHighlightTimerRef.current) {
        window.clearTimeout(clearHighlightTimerRef.current);
      }

      const socket = socketRef.current;
      if (socket && socket.readyState < WebSocket.CLOSING) {
        socket.close();
      }
      socketRef.current = null;
    };
  }, [connectSocket]);

  useEffect(() => {
    if (activeAlert) {
      return;
    }

    if (queuedAlerts.length > 0) {
      const [nextActive, ...remainingQueued] = queuedAlerts;
      setActiveAlert(nextActive);
      setQueuedAlerts(remainingQueued);
      return;
    }

    if (alerts.length > 0) {
      const [nextActive, ...remainingAlerts] = alerts;
      setActiveAlert(nextActive);
      setAlerts(remainingAlerts);
    }
  }, [activeAlert, alerts, queuedAlerts]);

  const handleActiveAlertComplete = (completedAlert) => {
    if (!completedAlert) {
      setActiveAlert(null);
      return;
    }

    const nextQueuedCandidate = queuedAlertsRef.current[0] || null;
    const nextLiveCandidate =
      alerts.find((item) => item.postId !== completedAlert.postId) || null;

    if (nextQueuedCandidate) {
      setActiveAlert(nextQueuedCandidate);
      setQueuedAlerts((current) =>
        current.filter((item) => item.postId !== nextQueuedCandidate.postId)
      );
    } else if (nextLiveCandidate) {
      setActiveAlert(nextLiveCandidate);
      setAlerts((current) =>
        current.filter((item) => item.postId !== nextLiveCandidate.postId)
      );
    } else {
      setActiveAlert(null);
    }

    setRecentAlerts((current) => upsertAlert(current, completedAlert));
    seenIdsRef.current.delete(completedAlert.id);

    setJustAddedId(completedAlert.id);

    if (clearHighlightTimerRef.current) {
      window.clearTimeout(clearHighlightTimerRef.current);
    }
    clearHighlightTimerRef.current = window.setTimeout(() => {
      setJustAddedId(null);
    }, 900);
  };

  useEffect(() => {
    window.localStorage.setItem(
      WATCHLIST_STORAGE_KEY,
      JSON.stringify(watchingSubreddits)
    );
  }, [watchingSubreddits]);

  useEffect(() => {
    const controller = new AbortController();

    const hydrateFromLatestSignals = async () => {
      try {
        const response = await fetch(LATEST_SIGNALS_URL, {
          signal: controller.signal,
        });
        if (!response.ok) {
          return;
        }

        const payload = await response.json();
        const snapshotAlerts = buildSnapshotAlerts(payload?.posts);
        if (snapshotAlerts.length === 0) {
          if (typeof payload?.error === "string" && payload.error.trim()) {
            setStreamError(payload.error.trim());
          }
          return;
        }

        setStreamError("");
        setActiveAlert((current) => current ?? snapshotAlerts[0] ?? null);
        setAlerts((current) => {
          const currentActivePostId = activeAlertRef.current?.postId;
          const queuedIds = new Set(queuedAlertsRef.current.map((alert) => alert.postId));
          const recentIds = new Set(recentAlertsRef.current.map((alert) => alert.postId));
          const excludedIds = new Set([
            currentActivePostId,
            ...queuedIds,
            ...recentIds,
          ].filter(Boolean));
          const merged = mergeUniqueAlerts(
            current,
            excludeAlertIds(snapshotAlerts, excludedIds)
          );
          return merged;
        });
      } catch (error) {
        if (error?.name !== "AbortError") {
          // Keep websocket/live path as primary; this is a silent fallback.
        }
      }
    };

    if (!activeAlertRef.current) {
      hydrateFromLatestSignals();
    }

    return () => controller.abort();
  }, [watchingSubreddits]);

  useEffect(() => {
    const controller = new AbortController();

    const syncWatchlist = async () => {
      setActiveAlert(null);
      setQueuedAlerts([]);
      setAlerts([]);
      setRecentAlerts([]);
      seenIdsRef.current = new Set();
      setStreamError("");

      try {
        const response = await fetch(WATCHLIST_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ subreddits: watchingSubreddits }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`watchlist sync failed: ${response.status}`);
        }

        const latestResponse = await fetch(LATEST_SIGNALS_URL, {
          signal: controller.signal,
        });
        if (!latestResponse.ok) {
          throw new Error(`latest signals failed: ${latestResponse.status}`);
        }

        const latestPayload = await latestResponse.json();
        const snapshotAlerts = buildSnapshotAlerts(latestPayload?.posts);
        if (snapshotAlerts.length > 0) {
          const [nextActive, ...remaining] = snapshotAlerts;
          setActiveAlert(nextActive ?? null);
          setAlerts(remaining);
          setStreamError("");
        } else if (typeof latestPayload?.error === "string" && latestPayload.error.trim()) {
          setStreamError(latestPayload.error.trim());
        }
      } catch (error) {
        if (error.name !== "AbortError") {
          setStreamError("Signal stream temporarily unavailable.");
        }
      }
    };

    syncWatchlist();

    return () => controller.abort();
  }, [watchingSubreddits]);

  const handleAddSubreddit = (name) => {
    setWatchingSubreddits((current) => {
      const cleaned = name.trim().replace(/^r\//i, "").toLowerCase();
      if (!cleaned || current.includes(cleaned) || current.length >= MAX_WATCHLIST_SIZE) {
        return current;
      }
      return normalizeWatchlist([...current, cleaned]);
    });
  };

  const handleRemoveSubreddit = (name) => {
    setWatchingSubreddits((current) => current.filter((item) => item !== name));
  };

  useEffect(() => {
    window.localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters));
  }, [filters]);

  const hasActiveFilters = useMemo(
    () => Object.entries(filters).some(([, value]) => value !== "all"),
    [filters]
  );

  const filteredActiveAlert = useMemo(() => {
    if (!activeAlert) {
      return null;
    }
    return passesFilters(activeAlert, filters) ? activeAlert : null;
  }, [activeAlert, filters]);

  const upcomingAlerts = useMemo(
    () =>
      mergeUniqueAlerts(queuedAlerts, alerts).filter(
        (alert) =>
          alert.postId !== activeAlert?.postId &&
          !recentAlerts.some((recentAlert) => recentAlert.postId === alert.postId)
      ),
    [activeAlert, alerts, queuedAlerts, recentAlerts]
  );

  const filteredRecentAlerts = useMemo(
    () =>
      recentAlerts.filter(
        (alert) =>
          alert.postId !== activeAlert?.postId && passesFilters(alert, filters)
      ),
    [activeAlert, filters, recentAlerts]
  );

  const feedPoolAlerts = useMemo(
    () =>
      mergeUniqueAlerts(recentAlerts, alerts).filter(
        (alert) =>
          alert.postId !== activeAlert?.postId &&
          !queuedAlerts.some((queuedAlert) => queuedAlert.postId === alert.postId)
      ),
    [activeAlert, alerts, queuedAlerts, recentAlerts]
  );

  const filteredFeedAlerts = useMemo(
    () => feedPoolAlerts.filter((alert) => passesFilters(alert, filters)),
    [feedPoolAlerts, filters]
  );

  const nextActivePreview = useMemo(
    () =>
      upcomingAlerts.find((alert) => passesFilters(alert, filters)) ||
      feedPoolAlerts.find((alert) => passesFilters(alert, filters)) ||
      null,
    [feedPoolAlerts, filters, upcomingAlerts]
  );

  const totalAlertPoolCount = useMemo(() => {
    const seen = new Set();
    let total = 0;

    for (const alert of [activeAlert, ...alerts].filter(Boolean)) {
      if (seen.has(alert.postId)) {
        continue;
      }
      seen.add(alert.postId);
      total += 1;
    }

    return total;
  }, [activeAlert, alerts]);

  const filteredAlertPoolCount = filteredFeedAlerts.length;
  const assistantSignals = useMemo(
    () => mergeUniqueAlerts([activeAlert], queuedAlerts, alerts, recentAlerts).filter(Boolean),
    [activeAlert, alerts, queuedAlerts, recentAlerts]
  );

  return (
    <div className="dashboard-shell">
      <div className="dashboard">
        <Sidebar
          activeAlert={activeAlert}
          totalSignals={totalAlertPoolCount}
          watchingSubreddits={watchingSubreddits}
          onAddSubreddit={handleAddSubreddit}
          onRemoveSubreddit={handleRemoveSubreddit}
          filters={filters}
          onChangeFilters={setFilters}
          onResetFilters={() => setFilters({ ...FILTER_DEFAULTS })}
          filterResultCount={filteredAlertPoolCount}
          filterTotalCount={feedPoolAlerts.length}
        />
        <main className="dashboard__content">
          <ActiveAlert
            alert={filteredActiveAlert}
            nextAlert={nextActivePreview}
            durationMs={ACTIVE_ALERT_MS}
            onComplete={handleActiveAlertComplete}
            errorMessage={streamError}
            assistantProps={{
              signals: assistantSignals,
              watchingSubreddits,
              isOpen: isAssistantOpen,
              onToggle: () => setIsAssistantOpen((current) => !current),
              chatUrl: ASSISTANT_CHAT_URL,
            }}
            emptyMessage={
              hasActiveFilters
                ? "No active signal matches the current filters."
                : "Waiting for the next signal..."
            }
          />

          <SignalFeed
            alerts={filteredFeedAlerts}
            highlightId={justAddedId}
            totalCount={totalAlertPoolCount}
            hasActiveFilters={hasActiveFilters}
            errorMessage={!hasActiveFilters ? streamError : ""}
          />
        </main>
      </div>
    </div>
  );
}

export default App;
