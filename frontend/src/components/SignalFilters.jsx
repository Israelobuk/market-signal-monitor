const FILTER_GROUPS = [
  {
    key: "timeRange",
    label: "Time range",
    options: [
      { value: "all", label: "All time" },
      { value: "1h", label: "Past hour" },
      { value: "6h", label: "Past 6h" },
      { value: "24h", label: "Past 24h" },
      { value: "7d", label: "Past 7d" },
    ],
  },
];

function SignalFilters({ filters, onChange, onReset, resultCount, totalCount }) {
  const handleOptionClick = (key, value) => () => {
    onChange((current) => ({
      ...current,
      [key]: value,
    }));
  };

  return (
    <section className="signal-filters" aria-label="Signal filters">
      <div className="signal-filters__header">
        <div>
          <p className="signal-filters__eyebrow">Feed controls</p>
          <h2 className="signal-filters__title">Filter signals</h2>
        </div>
        <div className="signal-filters__summary">
          <span className="signal-filters__badge">
            {resultCount} of {totalCount} shown
          </span>
          <button type="button" className="signal-filters__reset" onClick={onReset}>
            Reset
          </button>
        </div>
      </div>

      <div className="signal-filters__grid">
        {FILTER_GROUPS.map((group) => (
          <section key={group.key} className="signal-filters__group" aria-label={group.label}>
            <span className="signal-filters__group-label">{group.label}</span>
            <div className="signal-filters__options" role="group" aria-label={group.label}>
              {group.options.map((option) => {
                const active = filters[group.key] === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={
                      active
                        ? "signal-filters__option signal-filters__option--active"
                        : "signal-filters__option"
                    }
                    aria-pressed={active}
                    onClick={handleOptionClick(group.key, option.value)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

export default SignalFilters;
