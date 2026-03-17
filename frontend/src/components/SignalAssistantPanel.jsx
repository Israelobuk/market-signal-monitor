import { useEffect, useMemo, useRef, useState } from "react";

const MAX_CONTEXT_SIGNALS = 12;

function sortSignals(signals) {
  return [...signals].sort((left, right) => {
    const leftScore = Number(left.signalScore || 0) + Number(left.upvotes || 0) + Number(left.comments || 0) * 4;
    const rightScore = Number(right.signalScore || 0) + Number(right.upvotes || 0) + Number(right.comments || 0) * 4;
    if (rightScore !== leftScore) {
      return rightScore - leftScore;
    }
    return new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime();
  });
}

function dedupeSignals(signals) {
  const seen = new Set();
  const unique = [];

  for (const signal of sortSignals(signals)) {
    const key = signal.postId || signal.id;
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(signal);
    if (unique.length >= MAX_CONTEXT_SIGNALS) {
      break;
    }
  }

  return unique;
}

function relativeTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown time";
  }

  const seconds = Math.max(1, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatSignalReference(signal) {
  const tickers = Array.isArray(signal.aiTickers) ? signal.aiTickers.slice(0, 3).join(", ") : "";
  const summary = signal.aiSummary || signal.aiReason || signal.title;
  const tickerText = tickers ? ` | ${tickers}` : "";
  return `r/${signal.subreddit} ${relativeTime(signal.timestamp)}${tickerText}: ${summary}`;
}

function findSignalsForTicker(signals, ticker) {
  const normalized = ticker.toUpperCase();
  return signals.filter((signal) => {
    const aiTickers = Array.isArray(signal.aiTickers) ? signal.aiTickers : [];
    return (
      aiTickers.some((item) => String(item || "").toUpperCase() === normalized) ||
      String(signal.title || "").toUpperCase().includes(normalized)
    );
  });
}

function findSignalsForTopic(signals, terms) {
  return signals.filter((signal) => {
    const haystack = `${signal.title || ""} ${signal.aiSummary || ""} ${signal.aiReason || ""} ${signal.subreddit || ""}`.toLowerCase();
    return terms.some((term) => haystack.includes(term));
  });
}

function buildAssistantReply(message, contextSignals, watchingSubreddits) {
  if (contextSignals.length === 0) {
    return "No recent Reddit signal context is available yet. Keep the watchlist running and I’ll use the incoming posts as they arrive.";
  }

  const normalized = message.trim().toLowerCase();
  const rawTickerMatch = message.match(/\$?([A-Za-z]{2,6})\b/);
  const tickerCandidate = rawTickerMatch?.[1]?.toUpperCase() || "";

  if (tickerCandidate) {
    const tickerSignals = findSignalsForTicker(contextSignals, tickerCandidate);
    if (tickerSignals.length > 0) {
      const topMatches = tickerSignals.slice(0, 3).map(formatSignalReference).join("\n");
      return `Recent Reddit context for ${tickerCandidate}:\n${topMatches}`;
    }
  }

  if (
    normalized.includes("summary") ||
    normalized.includes("what matters") ||
    normalized.includes("overview") ||
    normalized.includes("top") ||
    normalized.includes("important")
  ) {
    const topSignals = contextSignals.slice(0, 3).map(formatSignalReference).join("\n");
    return `Top recent signal context:\n${topSignals}`;
  }

  if (normalized.includes("crypto") || normalized.includes("bitcoin") || normalized.includes("ethereum")) {
    const cryptoSignals = findSignalsForTopic(contextSignals, ["crypto", "bitcoin", "ethereum", "btc", "eth"]);
    if (cryptoSignals.length > 0) {
      return `Crypto-linked context right now:\n${cryptoSignals.slice(0, 3).map(formatSignalReference).join("\n")}`;
    }
  }

  if (normalized.includes("macro") || normalized.includes("fed") || normalized.includes("rates") || normalized.includes("inflation")) {
    const macroSignals = findSignalsForTopic(contextSignals, ["fed", "inflation", "cpi", "rates", "treasury", "yield", "macro", "economics"]);
    if (macroSignals.length > 0) {
      return `Macro context in the current signal set:\n${macroSignals.slice(0, 3).map(formatSignalReference).join("\n")}`;
    }
  }

  if (normalized.includes("watchlist") || normalized.includes("tracking") || normalized.includes("tracked")) {
    return `Current tracked subreddits: ${watchingSubreddits.map((item) => `r/${item}`).join(", ")}. I’m grounding responses in the latest analyzed posts from that set.`;
  }

  const leadSignal = contextSignals[0];
  const followSignals = contextSignals.slice(1, 3);
  const leadSummary = leadSignal.aiSummary || leadSignal.aiReason || leadSignal.title;
  const followSummary = followSignals.map(formatSignalReference).join("\n");

  return followSignals.length > 0
    ? `Primary context right now is ${leadSummary} from r/${leadSignal.subreddit}. Supporting signals:\n${followSummary}`
    : `Primary context right now is ${leadSummary} from r/${leadSignal.subreddit}.`;
}

function SignalAssistantPanel({ signals, watchingSubreddits, isOpen, onToggle }) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState([
    {
      id: "welcome",
      role: "assistant",
      content:
        "I can help interpret the latest Reddit signal flow, highlight notable tickers, and summarize what looks market-relevant from the current dashboard context.",
    },
  ]);
  const messagesRef = useRef(null);

  const contextSignals = useMemo(() => dedupeSignals(signals), [signals]);

  useEffect(() => {
    const container = messagesRef.current;
    if (!container) {
      return;
    }
    container.scrollTop = container.scrollHeight;
  }, [messages, isOpen]);

  const handleSend = () => {
    const cleaned = draft.trim();
    if (!cleaned) {
      return;
    }

    const reply = buildAssistantReply(cleaned, contextSignals, watchingSubreddits);
    setMessages((current) => [
      ...current,
      {
        id: `user-${Date.now()}`,
        role: "user",
        content: cleaned,
      },
      {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: reply,
      },
    ]);
    setDraft("");
  };

  const handleKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  };

  return (
    <aside
      className={
        isOpen
          ? "signal-ai-panel signal-ai-panel--open"
          : "signal-ai-panel"
      }
      aria-label="Signal AI assistant"
    >
      <button
        type="button"
        className="signal-ai-panel__toggle"
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-controls="signal-ai-panel-body"
      >
        <span className="signal-ai-panel__toggle-mark">AI</span>
        <span className="signal-ai-panel__toggle-label">Signal AI</span>
      </button>

      <div id="signal-ai-panel-body" className="signal-ai-panel__body">
        <header className="signal-ai-panel__header">
          <div>
            <p className="signal-ai-panel__eyebrow">Context assistant</p>
            <h2 className="signal-ai-panel__title">Signal AI</h2>
            <p className="signal-ai-panel__subtitle">
              Uses recent Reddit signal context from the backend to help you interpret what the feed is surfacing.
            </p>
          </div>
          <button
            type="button"
            className="signal-ai-panel__close"
            onClick={onToggle}
            aria-label="Collapse Signal AI"
          >
            &#8250;
          </button>
        </header>

        <div className="signal-ai-panel__status-row">
          <span className="signal-ai-panel__status-badge">
            {contextSignals.length} context items
          </span>
          <span className="signal-ai-panel__status-note">
            {watchingSubreddits.length} tracked subs
          </span>
        </div>

        <div className="signal-ai-panel__messages" ref={messagesRef}>
          {messages.map((message) => (
            <article
              key={message.id}
              className={
                message.role === "assistant"
                  ? "signal-ai-message signal-ai-message--assistant"
                  : "signal-ai-message signal-ai-message--user"
              }
            >
              <div className="signal-ai-message__role">
                {message.role === "assistant" ? "Signal AI" : "You"}
              </div>
              <div className="signal-ai-message__content">
                {message.content.split("\n").map((line, index) => (
                  <p key={`${message.id}-${index}`}>{line}</p>
                ))}
              </div>
            </article>
          ))}
        </div>

        <div className="signal-ai-panel__composer">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            className="signal-ai-panel__input"
            placeholder="Ask about tickers, macro themes, or what matters in the current feed..."
            rows={3}
          />
          <button
            type="button"
            className="signal-ai-panel__send"
            onClick={handleSend}
            disabled={!draft.trim()}
          >
            Send
          </button>
        </div>
      </div>
    </aside>
  );
}

export default SignalAssistantPanel;
