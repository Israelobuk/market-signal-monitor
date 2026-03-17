import AlertCard from "./AlertCard";

function SignalFeed({
  alerts,
  highlightId,
  totalCount = alerts.length,
  hasActiveFilters = false,
  errorMessage = "",
}) {
  const sortedAlerts = [...alerts].sort((left, right) => {
    const leftEngagement = (left.upvotes ?? 0) + (left.comments ?? 0);
    const rightEngagement = (right.upvotes ?? 0) + (right.comments ?? 0);

    if (rightEngagement !== leftEngagement) {
      return rightEngagement - leftEngagement;
    }

    return new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime();
  });

  return (
    <section id="reddit-signals" className="panel panel--feed">
      <header className="section-heading section-heading--feed">
        <div>
          <h2>Recent Signals</h2>
          <p>
            {hasActiveFilters
              ? "Filtered live updates from your tracked themes"
              : "Live updates from your tracked themes"}
          </p>
        </div>
        <span className="section-heading__badge">
          {hasActiveFilters ? `${sortedAlerts.length} of ${totalCount} shown` : `${sortedAlerts.length} tracked`}
        </span>
      </header>

      {sortedAlerts.length === 0 ? (
        <div className="signal-feed-empty">
          {errorMessage
            ? errorMessage
            : hasActiveFilters
            ? "No signals match the current filters."
            : "No signals yet. Live updates will appear here."}
        </div>
      ) : (
        <div className="signal-feed-list" role="list" aria-label="Recent signal feed">
          {sortedAlerts.map((alert) => (
            <div
              key={alert.id}
              role="listitem"
              className={
                alert.id === highlightId ? "signal-feed-item signal-feed-item--new" : "signal-feed-item"
              }
            >
              <AlertCard alert={alert} highlighted={alert.id === highlightId} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default SignalFeed;
