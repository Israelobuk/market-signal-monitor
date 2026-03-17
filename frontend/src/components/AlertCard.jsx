import { useEffect } from "react";
import { useRef } from "react";

function formatRelativeTime(value) {
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

function toEmbedUrl(postUrl) {
  if (!postUrl) {
    return null;
  }

  try {
    const parsed = new URL(postUrl, "https://reddit.com");
    const path = parsed.pathname.toLowerCase();
    if (!path.includes("/comments/")) {
      return null;
    }
    if (path.includes("/comments/mock") || path.includes("/comments/unknown")) {
      return null;
    }

    const normalizedPath = parsed.pathname.endsWith("/")
      ? parsed.pathname
      : `${parsed.pathname}/`;

    return `https://www.redditmedia.com${normalizedPath}?ref_source=embed&ref=share&embed=true`;
  } catch {
    return null;
  }
}

function AlertCard({
  alert,
  variant = "feed",
  highlighted = false,
  durationMs,
  onLifecycleEnd,
}) {
  const onLifecycleEndRef = useRef(onLifecycleEnd);

  useEffect(() => {
    onLifecycleEndRef.current = onLifecycleEnd;
  }, [onLifecycleEnd]);

  useEffect(() => {
    if (!onLifecycleEndRef.current || !durationMs) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      onLifecycleEndRef.current?.();
    }, durationMs);

    return () => window.clearTimeout(timer);
  }, [alert?.id, durationMs]);

  const embedUrl = toEmbedUrl(alert.post_url);
  const isSyntheticPost =
    String(alert?.username || "").toLowerCase() === "signal_monitor" ||
    String(alert?.id || "").startsWith("fallback-") ||
    String(alert?.postId || "").startsWith("fallback-");
  const showEmbed = variant === "active" && Boolean(embedUrl) && !isSyntheticPost;
  const showFeedImage = variant !== "active" && Boolean(alert.image);
  const hasFeedMedia = variant !== "active" && (showEmbed || showFeedImage);
  const showSummary = variant !== "active" && Boolean(alert.aiSummary);
  const showAiMeta =
    variant !== "active" &&
    (Boolean(alert.aiSector) || (Array.isArray(alert.aiTickers) && alert.aiTickers.length > 0));
  const showBodyText = variant === "active" && Boolean(alert.bodyText);

  const cardClasses = [
    "alert-card",
    variant === "active" ? "alert-card--active" : "alert-card--feed",
    variant !== "active" && showEmbed ? "alert-card--feed-embed" : "",
    variant !== "active" && !hasFeedMedia ? "alert-card--feed-no-media" : "",
    variant !== "active" && showSummary ? "alert-card--feed-with-summary" : "",
    highlighted ? "alert-card--highlighted" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article
      className={cardClasses}
      style={durationMs ? { "--active-duration": `${durationMs}ms` } : undefined}
    >
      <div className="alert-card__meta-row">
        <span>{alert.username}</span>
        <span className="alert-card__meta-sep">•</span>
        <span>{alert.subreddit}</span>
        <span className="alert-card__meta-sep">•</span>
        <span>{formatRelativeTime(alert.timestamp)}</span>
      </div>

      {!showEmbed ? (
        <h3 className="alert-card__title">
          <a href={alert.post_url} target="_blank" rel="noopener noreferrer">
            {alert.title}
          </a>
        </h3>
      ) : null}

      {showSummary ? (
        <p className="alert-card__summary">{alert.aiSummary}</p>
      ) : null}

      {showBodyText ? (
        <div className="alert-card__body-copy">
          {alert.bodyText
            .split(/\n+/)
            .map((paragraph) => paragraph.trim())
            .filter(Boolean)
            .slice(0, 4)
            .map((paragraph, index) => (
              <p key={`${alert.id}-body-${index}`}>{paragraph}</p>
            ))}
        </div>
      ) : null}

      {showAiMeta ? (
        <div className="alert-card__ai-meta" aria-label="AI post metadata">
          {alert.aiSector ? (
            <span className="alert-card__ai-chip">{alert.aiSector}</span>
          ) : null}
          {Array.isArray(alert.aiTickers)
            ? alert.aiTickers.slice(0, 3).map((ticker) => (
                <span key={ticker} className="alert-card__ai-chip alert-card__ai-chip--ticker">
                  ${ticker}
                </span>
              ))
            : null}
        </div>
      ) : null}

      {showEmbed ? (
        <div
          className={
            variant === "active"
              ? "alert-card__embed-wrap alert-card__embed-wrap--active"
              : "alert-card__embed-wrap alert-card__embed-wrap--feed"
          }
        >
          <iframe
            title={`Signal post ${alert.id}`}
            src={embedUrl}
            className="alert-card__embed"
            loading="lazy"
          />
        </div>
      ) : showFeedImage ? (
        <a
          href={alert.post_url}
          target="_blank"
          rel="noopener noreferrer"
          className="alert-card__image-link alert-card__image-link--feed"
        >
          <img
            src={alert.image}
            alt="Post thumbnail"
            className="alert-card__image alert-card__image--feed"
            loading="lazy"
          />
        </a>
      ) : alert.image ? (
        <a
          href={alert.post_url}
          target="_blank"
          rel="noopener noreferrer"
          className="alert-card__image-link"
        >
          <img
            src={alert.image}
            alt="Post thumbnail"
            className="alert-card__image"
            loading="lazy"
          />
        </a>
      ) : null}

      <div className="alert-card__stats" aria-label="Engagement stats">
        <span className="alert-card__stat">↑ {alert.upvotes}</span>
        <span className="alert-card__stat">💬 {alert.comments}</span>
      </div>

      <footer className="alert-card__footer">
        <a href={alert.post_url} target="_blank" rel="noopener noreferrer">
          Open source
        </a>
      </footer>
    </article>
  );
}

export default AlertCard;
