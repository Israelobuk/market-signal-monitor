function SubredditChip({ name, onRemove }) {
  return (
    <span className="subreddit-chip">
      <span>{name}</span>
      <button
        type="button"
        className="subreddit-chip__remove"
        onClick={(event) => {
          event.stopPropagation();
          onRemove(name);
        }}
        aria-label={`Remove ${name}`}
      >
        x
      </button>
    </span>
  );
}

export default SubredditChip;
