import { useEffect, useState } from "react";

const MARKET_MODES = {
  popular: {
    label: "Most popular",
    empty: "Popular stocks unavailable.",
  },
  volatile: {
    label: "Most volatile",
    empty: "Volatility leaders unavailable.",
  },
  pullbacks: {
    label: "Pullbacks",
    empty: "Pullback names unavailable.",
  },
};
const MARKET_MODE_KEYS = ["popular", "volatile", "pullbacks"];

function formatChange(change) {
  return `${change > 0 ? "+" : ""}${change.toFixed(1)}%`;
}

function resolveApiBaseUrl() {
  if (import.meta.env.VITE_API_BASE_URL) {
    return import.meta.env.VITE_API_BASE_URL;
  }

  const isLocalDev = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  if (isLocalDev) {
    return `${window.location.protocol}//${window.location.hostname}:8000`;
  }

  return `${window.location.protocol}//${window.location.host}`;
}

function chunkStocks(stocks, chunkSize = 3) {
  const frames = [];

  for (let index = 0; index < stocks.length; index += chunkSize) {
    frames.push(stocks.slice(index, index + chunkSize));
  }

  return frames.filter((frame) => frame.length > 0);
}

function getMarketMoversUrls() {
  const urls = [];
  const isLocalDev = ["localhost", "127.0.0.1"].includes(window.location.hostname);

  if (import.meta.env.VITE_MARKET_API_URL) {
    urls.push(import.meta.env.VITE_MARKET_API_URL);
  }

  if (isLocalDev) {
    urls.push(`${window.location.protocol}//${window.location.hostname}:8001/api/market-movers`);
  }

  const primaryBaseUrl = resolveApiBaseUrl();
  urls.push(`${primaryBaseUrl}/api/market-movers`);

  return [...new Set(urls)];
}

const MARKET_MOVERS_URLS = getMarketMoversUrls();

function buildChartGeometry(points, previousClose, width = 148, height = 84) {
  const pivot = Number.isFinite(previousClose) ? previousClose : null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const midpoint = (min + max) / 2;
  const rawSpan = max - min;
  const minVisibleSpan = Math.max(Math.abs(midpoint) * 0.002, 0.05);
  const effectiveSpan = Math.max(rawSpan, minVisibleSpan);
  const padding = effectiveSpan * 0.12;
  const scaledMin = midpoint - effectiveSpan / 2 - padding;
  const scaledMax = midpoint + effectiveSpan / 2 + padding;
  const range = Math.max(scaledMax - scaledMin, 1e-6);

  const path = points
    .map((point, index) => {
      const x = (index / (points.length - 1)) * width;
      const y = height - ((point - scaledMin) / range) * height;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");

  const baselineY =
    pivot !== null && pivot >= scaledMin && pivot <= scaledMax
      ? height - ((pivot - scaledMin) / range) * height
      : null;

  return {
    path,
    baselineY:
      baselineY === null ? null : Math.max(0, Math.min(height, baselineY)),
  };
}

function MiniStockGrid() {
  const [mode, setMode] = useState("popular");
  const [frameIndex, setFrameIndex] = useState(0);
  const [modeDirection, setModeDirection] = useState("next");
  const [modeTransitionKey, setModeTransitionKey] = useState(0);
  const [framesByMode, setFramesByMode] = useState({
    popular: [],
    volatile: [],
    pullbacks: [],
  });
  const [marketSource, setMarketSource] = useState("loading");

  useEffect(() => {
    const frames = framesByMode[mode] || [];
    if (frames.length === 0) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setFrameIndex((current) => (current + 1) % frames.length);
    }, 2000);

    return () => window.clearInterval(timer);
  }, [framesByMode, mode]);

  useEffect(() => {
    setFrameIndex(0);
  }, [mode]);

  useEffect(() => {
    const controller = new AbortController();

    const fetchMovers = async () => {
      try {
        for (const url of MARKET_MOVERS_URLS) {
          const response = await fetch(url, {
            signal: controller.signal,
          });
          if (!response.ok) {
            continue;
          }

          const payload = await response.json();
          const nextSets = payload?.sets && typeof payload.sets === "object"
            ? payload.sets
            : {
                popular: Array.isArray(payload?.results) ? payload.results : [],
                volatile: [],
                pullbacks: [],
              };
          const nextFramesByMode = {
            popular: chunkStocks(Array.isArray(nextSets?.popular) ? nextSets.popular : []),
            volatile: chunkStocks(Array.isArray(nextSets?.volatile) ? nextSets.volatile : []),
            pullbacks: chunkStocks(Array.isArray(nextSets?.pullbacks) ? nextSets.pullbacks : []),
          };
          if (
            nextFramesByMode.popular.length > 0 ||
            nextFramesByMode.volatile.length > 0 ||
            nextFramesByMode.pullbacks.length > 0
          ) {
            setFramesByMode(nextFramesByMode);
            setFrameIndex(0);
            setMarketSource("live");
            return;
          }
        }

        setFramesByMode({
          popular: [],
          volatile: [],
          pullbacks: [],
        });
        setFrameIndex(0);
        setMarketSource("unavailable");
      } catch (error) {
        if (error.name !== "AbortError") {
          setFramesByMode({
            popular: [],
            volatile: [],
            pullbacks: [],
          });
          setFrameIndex(0);
          setMarketSource("unavailable");
        }
      }
    };

    fetchMovers();
    const refreshTimer = window.setInterval(fetchMovers, 60000);

    return () => {
      controller.abort();
      window.clearInterval(refreshTimer);
    };
  }, []);

  const frames = framesByMode[mode] || [];
  const stocks = frames[frameIndex] || [];
  const statusLabel =
    marketSource === "live"
      ? "Live"
      : marketSource === "loading"
        ? "Loading"
        : "Unavailable";
  const modeConfig = MARKET_MODES[mode] || MARKET_MODES.popular;
  const stackClasses = [
    "mini-stock-grid__stack",
    modeDirection === "prev"
      ? "mini-stock-grid__stack--slide-prev"
      : "mini-stock-grid__stack--slide-next",
  ].join(" ");

  const stepMode = (direction) => {
    setModeDirection(direction > 0 ? "next" : "prev");
    setMode((current) => {
      const currentIndex = MARKET_MODE_KEYS.indexOf(current);
      const nextIndex = (currentIndex + direction + MARKET_MODE_KEYS.length) % MARKET_MODE_KEYS.length;
      return MARKET_MODE_KEYS[nextIndex];
    });
    setModeTransitionKey((current) => current + 1);
  };

  return (
    <aside className="mini-stock-grid" aria-label="Market movers widget">
      <div className="mini-stock-grid__header">
        <div className="mini-stock-grid__headline">
          <p className="mini-stock-grid__eyebrow">Market pulse</p>
          <div className="mini-stock-grid__controls">
            <span
              className={
                marketSource === "live"
                  ? "mini-stock-grid__status mini-stock-grid__status--live"
                  : "mini-stock-grid__status"
              }
            >
              {statusLabel}
            </span>
          </div>
        </div>
        <div className="mini-stock-grid__title-row">
          <div className="mini-stock-grid__tabs" aria-label="Market view mode">
            <button
              type="button"
              className="mini-stock-grid__arrow mini-stock-grid__arrow--inline"
              aria-label="Show previous market view"
              onClick={() => stepMode(-1)}
            >
              &#8249;
            </button>
            <button
              type="button"
              className="mini-stock-grid__tab mini-stock-grid__tab--active mini-stock-grid__tab--single"
              aria-label={`Current market view: ${modeConfig.label}`}
              onClick={() => stepMode(1)}
            >
              {modeConfig.label}
            </button>
            <button
              type="button"
              className="mini-stock-grid__arrow mini-stock-grid__arrow--inline"
              aria-label="Show next market view"
              onClick={() => stepMode(1)}
            >
              &#8250;
            </button>
          </div>
        </div>
      </div>

      {stocks.length === 0 ? (
        <div className="mini-stock-grid__empty">
          {marketSource === "loading"
            ? "Loading market view..."
            : modeConfig.empty}
        </div>
      ) : (
        <div className={stackClasses} key={`${mode}-${modeTransitionKey}-${marketSource}-${frameIndex}`}>
          {stocks.map((stock) => {
            const positive = stock.change >= 0;
            const chart = buildChartGeometry(stock.points, stock.previous_close);

            return (
              <div
                key={`${mode}-${marketSource}-${frameIndex}-${stock.ticker}`}
                className={
                  positive
                    ? "mini-stock-grid__tile mini-stock-grid__tile--positive"
                    : "mini-stock-grid__tile mini-stock-grid__tile--negative"
                }
              >
                <div className="mini-stock-grid__tile-head">
                  <span className="mini-stock-grid__ticker">{stock.ticker}</span>
                  <span className="mini-stock-grid__window">24H</span>
                </div>

                <div className="mini-stock-grid__chart" aria-hidden="true">
                  <svg viewBox="0 0 148 84" className="mini-stock-grid__chart-svg">
                    {chart.baselineY !== null ? (
                      <line
                        x1="0"
                        y1={chart.baselineY}
                        x2="148"
                        y2={chart.baselineY}
                        className="mini-stock-grid__baseline"
                      />
                    ) : null}
                    <path
                      d={chart.path}
                      className="mini-stock-grid__line"
                    />
                  </svg>
                </div>

                <span className="mini-stock-grid__change">{formatChange(stock.change)}</span>
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}

export default MiniStockGrid;
