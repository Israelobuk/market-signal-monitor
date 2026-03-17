import SearchSubreddit from "./SearchSubreddit";
import SubredditChip from "./SubredditChip";
import SignalFilters from "./SignalFilters";
import signalDeskIcon from "../assets/signal-desk-icon.png";

function Sidebar({
  activeAlert,
  totalSignals,
  watchingSubreddits,
  onAddSubreddit,
  onRemoveSubreddit,
  filters,
  onChangeFilters,
  onResetFilters,
  filterResultCount,
  filterTotalCount,
}) {
  return (
    <aside className="dashboard-sidebar">
      <div className="sidebar-mainrow">
        <div className="sidebar-brand sidebar-brand--compact">
          <div className="sidebar-brand__mark" aria-hidden="true">
            <img
              src={signalDeskIcon}
              alt=""
              className="sidebar-brand__logo"
            />
          </div>
          <div className="sidebar-brand__copy">
            <h2 className="sidebar-brand__title">Signal Desk</h2>
            <p className="sidebar-brand__eyebrow">Realtime Monitor</p>
          </div>
        </div>

        <div className="sidebar-search">
          <SearchSubreddit
            watchingSubreddits={watchingSubreddits}
            onAdd={onAddSubreddit}
          />
        </div>

        <section className="sidebar-section sidebar-section--stats">
          <div className="sidebar-metrics">
            <div className="sidebar-metric">
              <span className="sidebar-metric__value">{totalSignals}</span>
              <span className="sidebar-metric__label">Signals</span>
            </div>
            <div className="sidebar-metric">
              <span className="sidebar-metric__value">{activeAlert ? 1 : 0}</span>
              <span className="sidebar-metric__label">Active</span>
            </div>
          </div>
        </section>
      </div>

      <section className="sidebar-section sidebar-section--watching">
        <div className="sidebar-watchlist-header">
          <p className="sidebar-panel__label">Watching</p>
          <span className="sidebar-watchlist-count">{watchingSubreddits.length}</span>
        </div>
        <div className="sidebar-tags">
          {watchingSubreddits.map((subreddit) => (
            <SubredditChip
              key={subreddit}
              name={subreddit}
              onRemove={onRemoveSubreddit}
            />
          ))}
        </div>
      </section>

      <SignalFilters
        filters={filters}
        onChange={onChangeFilters}
        onReset={onResetFilters}
        resultCount={filterResultCount}
        totalCount={filterTotalCount}
      />
    </aside>
  );
}

export default Sidebar;
