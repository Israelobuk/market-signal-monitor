import AlertCard from "./AlertCard";
import MiniStockGrid from "./MiniStockGrid";
import SignalAssistantDock from "./SignalAssistantDock";

function ActiveAlert({
  alert,
  nextAlert,
  durationMs,
  onComplete,
  errorMessage,
  emptyMessage,
  assistantProps,
}) {
  const showAiInsight =
    Boolean(alert?.aiSummary) ||
    Boolean(alert?.aiReason) ||
    Boolean(alert?.aiSector) ||
    (Array.isArray(alert?.aiTickers) && alert.aiTickers.length > 0);

  return (
    <section
      id="active-alert"
      className="panel panel--active"
      aria-live="polite"
      aria-atomic="true"
    >
      <header className="section-heading">
        <h2>Active Alert</h2>
        <p>Current signal</p>
      </header>

      <div className="active-alert-stage">
        <div className="active-alert-grid">
          <div className="active-alert-grid__post-column">
            <div className="active-alert-grid__post">
              {alert ? (
                <AlertCard
                  key={alert.id}
                  alert={alert}
                  variant="active"
                  durationMs={durationMs}
                  onLifecycleEnd={() => onComplete(alert)}
                />
              ) : errorMessage ? (
                <div className="active-alert-placeholder active-alert-placeholder--error">
                  {errorMessage}
                </div>
              ) : (
                <div className="active-alert-placeholder">
                  {emptyMessage || "Waiting for the next signal..."}
                </div>
              )}
            </div>

            {alert && showAiInsight ? (
              <section className="active-alert-grid__insight" aria-label="AI interpretation">
                <div className="active-alert-grid__insight-header">
                  <span>AI read</span>
                </div>
                {alert.aiSummary ? (
                  <p className="active-alert-grid__insight-summary">{alert.aiSummary}</p>
                ) : null}
                {alert.aiReason ? (
                  <p className="active-alert-grid__insight-reason">{alert.aiReason}</p>
                ) : null}
                {alert.aiSector || (Array.isArray(alert.aiTickers) && alert.aiTickers.length > 0) ? (
                  <div className="active-alert-grid__insight-chips" aria-label="AI metadata">
                    {alert.aiSector ? (
                      <span className="active-alert-grid__insight-chip">{alert.aiSector}</span>
                    ) : null}
                    {Array.isArray(alert.aiTickers)
                      ? alert.aiTickers.slice(0, 3).map((ticker) => (
                          <span
                            key={ticker}
                            className="active-alert-grid__insight-chip active-alert-grid__insight-chip--ticker"
                          >
                            ${ticker}
                          </span>
                        ))
                      : null}
                  </div>
                ) : null}
              </section>
            ) : null}

            <div className="active-alert-grid__next">
              <div className="active-alert-grid__next-header">
                <span>Up next</span>
              </div>
              {nextAlert ? (
                <AlertCard alert={nextAlert} />
              ) : (
                <div className="active-alert-placeholder active-alert-placeholder--next">
                  Waiting for another signal...
                </div>
              )}
            </div>
          </div>

          <div className="active-alert-grid__sidebar">
            <div id="market-movers">
              <MiniStockGrid />
            </div>
            <SignalAssistantDock {...assistantProps} />
          </div>
        </div>
      </div>
    </section>
  );
}

export default ActiveAlert;
