import { useEffect, useMemo, useRef, useState } from "react";

const MARKET_SUBREDDIT_CATALOG = [
  "alphabet",
  "ai",
  "algotrading",
  "amazon",
  "amd",
  "apple",
  "autos",
  "banks",
  "biotech",
  "bitcoin",
  "bonds",
  "broadcom",
  "news",
  "business",
  "china",
  "coinbase",
  "commodities",
  "cryptocurrency",
  "cryptomarkets",
  "daytrading",
  "defense",
  "disney",
  "dividends",
  "economics",
  "economy",
  "energy",
  "ethereum",
  "ethtrader",
  "europe",
  "fed",
  "finance",
  "fixedincome",
  "ford",
  "forex",
  "geopolitics",
  "gold",
  "healthcare",
  "housing",
  "industrials",
  "inflation",
  "intel",
  "investing",
  "jpmorgan",
  "macro",
  "meta",
  "microsoft",
  "netflix",
  "nvidia",
  "oil",
  "options",
  "oracle",
  "palantir",
  "quant",
  "payments",
  "paypal",
  "pharma",
  "preciousmetals",
  "privateequity",
  "rates",
  "realestate",
  "retail",
  "rivian",
  "securityanalysis",
  "semiconductors",
  "shipping",
  "silver",
  "snowflake",
  "stockmarket",
  "stocks",
  "tesla",
  "technology",
  "tsmc",
  "uranium",
  "visa",
  "valueinvesting",
  "wallstreetbets",
  "worldnews",
];

const MARKET_SUBREDDIT_SET = new Set(MARKET_SUBREDDIT_CATALOG);
const MAX_WATCHLIST_SIZE = 20;

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

const SUBREDDIT_SEARCH_URL = `${resolveBackendBaseUrl()}/api/subreddits/search`;

function isValidTheme(value) {
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(value);
}

function sortSuggestions(items, query) {
  const normalizedQuery = query.trim().toLowerCase().replace(/^r\//i, "");
  return [...items].sort((left, right) => left.localeCompare(right));
}

function isPrefixLikeMatch(item, query) {
  return item
    .toLowerCase()
    .split(/[\s/-]+/)
    .some((part) => part.startsWith(query));
}

function SearchSubreddit({ watchingSubreddits, onAdd }) {
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [serverSuggestions, setServerSuggestions] = useState([]);
  const rootRef = useRef(null);

  const filteredSuggestions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase().replace(/^r\//i, "");
    if (!normalizedQuery) {
      return [];
    }

    const pool =
      serverSuggestions.length > 0
        ? [...watchingSubreddits, ...serverSuggestions]
        : [...watchingSubreddits, ...MARKET_SUBREDDIT_CATALOG];
    const seen = new Set();

    const prefixMatches = [];
    const containsMatches = [];

    for (const item of pool) {
      const cleaned = String(item || "").trim().toLowerCase().replace(/^r\//i, "");
      if (
        !cleaned ||
        seen.has(cleaned) ||
        watchingSubreddits.includes(cleaned) ||
        !MARKET_SUBREDDIT_SET.has(cleaned)
      ) {
        continue;
      }
      seen.add(cleaned);
      if (isPrefixLikeMatch(cleaned, normalizedQuery)) {
        prefixMatches.push(cleaned);
        continue;
      }
      if (cleaned.includes(normalizedQuery)) {
        containsMatches.push(cleaned);
      }
    }

    const deduped = prefixMatches.length > 0 ? prefixMatches : containsMatches;
    return sortSuggestions(deduped, normalizedQuery).slice(0, 20);
  }, [query, serverSuggestions, watchingSubreddits]);

  useEffect(() => {
    if (!query.trim()) {
      setIsOpen(false);
      setHighlightedIndex(0);
      return undefined;
    }

    setIsOpen(true);
    setHighlightedIndex(0);
    return undefined;
  }, [query]);

  useEffect(() => {
    const normalizedQuery = query.trim().toLowerCase().replace(/^r\//i, "");
    if (!normalizedQuery) {
      setServerSuggestions([]);
      return undefined;
    }

    const controller = new AbortController();

    const loadSuggestions = async () => {
      try {
        const response = await fetch(
          `${SUBREDDIT_SEARCH_URL}?q=${encodeURIComponent(normalizedQuery)}`,
          { signal: controller.signal }
        );
        if (!response.ok) {
          throw new Error(`search failed: ${response.status}`);
        }
        const payload = await response.json();
        const nextSuggestions = Array.isArray(payload?.results)
          ? payload.results
              .map((item) => String(item || "").trim().toLowerCase().replace(/^r\//i, ""))
              .filter((item) => isValidTheme(item))
          : [];
        setServerSuggestions(nextSuggestions);
      } catch (error) {
        if (error.name !== "AbortError") {
          setServerSuggestions([]);
        }
      }
    };

    loadSuggestions();
    return () => controller.abort();
  }, [query]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (!rootRef.current?.contains(event.target)) {
        setIsOpen(false);
      }
    };

    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const commitSelection = (value) => {
    const cleaned = value.trim().replace(/^r\//i, "").toLowerCase();
    if (
      !cleaned ||
      !isValidTheme(cleaned) ||
      watchingSubreddits.includes(cleaned) ||
      watchingSubreddits.length >= MAX_WATCHLIST_SIZE
    ) {
      return;
    }
    onAdd(cleaned);
    setQuery("");
    setIsOpen(false);
    setHighlightedIndex(0);
    setServerSuggestions([]);
  };

  const handleKeyDown = (event) => {
    const cleanedQuery = query.trim().replace(/^r\//i, "").toLowerCase();

    if (!isOpen || filteredSuggestions.length === 0) {
      if (event.key === "Enter" && cleanedQuery && isValidTheme(cleanedQuery)) {
        event.preventDefault();
        commitSelection(cleanedQuery);
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedIndex((current) => (current + 1) % filteredSuggestions.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((current) =>
        current === 0 ? filteredSuggestions.length - 1 : current - 1
      );
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      commitSelection(filteredSuggestions[highlightedIndex] || query);
      return;
    }

    if (event.key === "Escape") {
      setIsOpen(false);
    }
  };

  return (
    <div className="search-subreddit" ref={rootRef}>
      <input
        type="text"
        value={query}
        className="search-input"
        placeholder="Search market themes..."
        onChange={(event) => setQuery(event.target.value)}
        onFocus={() => {
          if (query.trim()) {
            setIsOpen(true);
          }
        }}
        onKeyDown={handleKeyDown}
      />

      {isOpen ? (
        <div className="dropdown" role="listbox" aria-label="Market theme suggestions">
          {watchingSubreddits.length >= MAX_WATCHLIST_SIZE ? (
            <div className="dropdown-item dropdown-item--muted">Watchlist limit reached</div>
          ) : null}

          {watchingSubreddits.length < MAX_WATCHLIST_SIZE && filteredSuggestions.length === 0 ? (
            <div className="dropdown-item dropdown-item--muted">
              Press Enter to track this exact market theme
            </div>
          ) : null}

          {filteredSuggestions.map((suggestion, index) => (
            <button
              key={suggestion}
              type="button"
              className={
                index === highlightedIndex
                  ? "dropdown-item dropdown-item--active"
                  : "dropdown-item"
              }
              onMouseEnter={() => setHighlightedIndex(index)}
              onClick={() => commitSelection(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default SearchSubreddit;
