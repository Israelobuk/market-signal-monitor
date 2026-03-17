"""Reddit ingestion module for Market Signal Monitor."""

from __future__ import annotations

import hashlib
import html
import json
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from typing import Any, Optional, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import ProxyHandler, Request, build_opener

import praw
from praw.models import Submission


MARKET_SUBREDDIT_CATALOG = (
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
    "microsoft",
    "macro",
    "meta",
    "netflix",
    "nvidia",
    "oil",
    "options",
    "oracle",
    "quant",
    "palantir",
    "payments",
    "pharma",
    "paypal",
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
)

PUBLIC_JSON_LIMIT = 25
PUBLIC_JSON_SOURCES = ("new", "hot")
PUBLIC_JSON_BASE_URLS = (
    "https://www.reddit.com",
    "https://reddit.com",
)

MARKET_NEWS_RSS_FEEDS = (
    ("Reuters Business", "https://feeds.reuters.com/reuters/businessNews"),
    ("Reuters World", "https://feeds.reuters.com/reuters/worldNews"),
    ("Reuters Company", "https://feeds.reuters.com/reuters/companyNews"),
    ("CNBC Top News", "https://www.cnbc.com/id/100003114/device/rss/rss.html"),
    ("CNBC Finance", "https://www.cnbc.com/id/10000664/device/rss/rss.html"),
    ("WSJ Markets", "https://feeds.a.dj.com/rss/RSSMarketsMain.xml"),
    ("WSJ World", "https://feeds.a.dj.com/rss/RSSWorldNews.xml"),
    ("MarketWatch Top Stories", "https://feeds.marketwatch.com/marketwatch/topstories/"),
    ("MarketWatch MarketPulse", "https://feeds.marketwatch.com/marketwatch/marketpulse/"),
)

GOOGLE_NEWS_OUTLET_FILTER = (
    "site:reuters.com OR site:cnbc.com OR site:wsj.com OR site:marketwatch.com "
    "OR site:bloomberg.com OR site:finance.yahoo.com OR site:apnews.com"
)

GOOGLE_NEWS_RSS_TEMPLATE = (
    "https://news.google.com/rss/search?"
    "q={query}&hl=en-US&gl=US&ceid=US:en"
)

ALLOWED_MARKET_SUBREDDITS = {name.lower() for name in MARKET_SUBREDDIT_CATALOG}

MARKET_IMPACT_KEYWORDS = (
    "announces",
    "announced",
    "announcement",
    "earnings",
    "revenue",
    "guidance",
    "outlook",
    "forecast",
    "beats",
    "misses",
    "cpi",
    "inflation",
    "fed",
    "federal reserve",
    "treasury",
    "yield",
    "interest rates",
    "rate cut",
    "rate hike",
    "jobs report",
    "payrolls",
    "unemployment",
    "gdp",
    "recession",
    "stimulus",
    "demand",
    "supply",
    "trade deal",
    "tariff",
    "sanctions",
    "exports",
    "imports",
    "export ban",
    "import ban",
    "opec",
    "hormuz",
    "strait of hormuz",
    "oil supply",
    "oil",
    "gas",
    "energy",
    "sec",
    "etf",
    "approval",
    "approved",
    "lawsuit",
    "settlement",
    "merger",
    "acquisition",
    "bankruptcy",
    "layoffs",
    "guidance cut",
    "guidance raise",
    "downgrade",
    "upgrade",
    "hack",
    "breach",
    "bank",
    "banking",
    "regulation",
    "regulatory",
    "bitcoin etf",
    "ethereum etf",
    "bitcoin",
    "ethereum",
    "crypto",
    "btc",
    "eth",
    "crypto regulation",
    "forecast",
    "nowcast",
    "estimate",
    "estimates",
    "semiconductor",
    "chip",
    "chipmaker",
    "ai demand",
    "data center",
    "merger arbitrage",
    "ceo",
    "cfo",
    "chair",
    "chairman",
    "chairwoman",
    "analyst",
    "bank of america",
    "goldman sachs",
    "j p morgan",
    "jp morgan",
    "morgan stanley",
    "blackrock",
    "vanguard",
    "ubs",
    "citigroup",
    "deutsche bank",
    "hsbc",
    "forecasting",
    "dovish",
    "hawkish",
    "bullish",
    "bearish",
    "expects",
    "expectation",
    "expects",
    "expects to",
    "warns",
    "warning",
    "signals",
    "signal",
    "commentary",
    "strategist",
    "outflows",
    "inflows",
    "capital expenditure",
    "capex",
    "buyback",
    "share repurchase",
    "dividend",
    "default",
    "debt ceiling",
    "consumer spending",
    "retail sales",
    "housing",
    "manufacturing",
    "pmi",
)

MARKET_EVENT_KEYWORDS = (
    "breaking",
    "report",
    "reports",
    "reported",
    "headline",
    "announces",
    "announced",
    "announcement",
    "beats",
    "misses",
    "guidance",
    "forecast",
    "outlook",
    "approval",
    "approved",
    "lawsuit",
    "settlement",
    "merger",
    "acquisition",
    "downgrade",
    "upgrade",
    "raises",
    "cuts",
    "cut",
    "hike",
    "launches",
    "files",
    "says",
    "said",
    "warns",
    "expects",
    "expected",
    "sees",
    "notes",
    "calls",
    "commentary",
    "interview",
    "memo",
    "statement",
    "speaks",
    "speaking",
    "opinion",
    "view",
    "views",
)

HARD_BLOCK_KEYWORDS = (
    "porn",
    "nudity",
    "nsfw",
    "onlyfans",
    "shitpost",
    "meme",
    "gain porn",
    "loss porn",
    "to the moon",
    "diamond hands",
    "paper hands",
    "lambo",
    "ape",
    "apes",
    "bagholder",
    "bagholding",
)

DISCUSSION_OR_SPAM_KEYWORDS = (
    "daily discussion",
    "weekend discussion",
    "what are your moves",
    "what are we buying",
    "rate my portfolio",
    "my portfolio",
    "yolo",
    "mooning",
    "technical analysis",
    "position",
    "positions",
    "dd thread",
)

NON_NEWS_MEDIA_HOSTS = {
    "reddit.com",
    "www.reddit.com",
    "old.reddit.com",
    "redd.it",
    "i.redd.it",
    "preview.redd.it",
    "v.redd.it",
    "imgur.com",
    "i.imgur.com",
    "giphy.com",
    "media.giphy.com",
    "tenor.com",
    "youtube.com",
    "www.youtube.com",
    "youtu.be",
    "twitter.com",
    "www.twitter.com",
    "x.com",
    "www.x.com",
    "instagram.com",
    "www.instagram.com",
    "tiktok.com",
    "www.tiktok.com",
}

NON_NEWS_MEDIA_EXTENSIONS = (
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".mp4",
    ".mov",
    ".webm",
)

EMERGENCY_SIGNAL_TEMPLATES = {
    "macro": (
        "Macro desk is in fallback mode while Reddit throttles public feeds; watch rates, inflation, and policy headlines for confirmation.",
        "Macro sensitivity remains elevated while live Reddit signal ingestion is recovering.",
    ),
    "stocks": (
        "Large-cap leadership remains the cleanest fallback focus while live Reddit signal ingestion is recovering.",
        "Equity leadership is still concentrated in liquid large-cap names while Reddit feed recovery is in progress.",
    ),
    "crypto": (
        "Crypto risk appetite is worth tracking only alongside regulation, ETF-flow, and liquidity headlines.",
        "Crypto signals remain headline-driven; focus on liquidity, regulation, and ETF-related follow-through.",
    ),
    "energy": (
        "Energy-sensitive names stay in focus when supply, SPR, or geopolitical oil headlines dominate the tape.",
        "Energy remains the clearest fallback watch when supply disruptions or oil-policy headlines pick up.",
    ),
    "geopolitics": (
        "Geopolitical macro is elevated; watch global-news headlines for second-order pressure on commodities, yields, and risk sentiment.",
        "Global-event risk remains elevated, with commodity, shipping, and rates sensitivity most likely to react first.",
    ),
}

EMERGENCY_THEME_MAP = {
    "cryptocurrency": "crypto",
    "bitcoin": "crypto",
    "ethereum": "crypto",
    "ethtrader": "crypto",
    "cryptomarkets": "crypto",
    "oil": "energy",
    "energy": "energy",
    "worldnews": "geopolitics",
    "geopolitics": "geopolitics",
    "economics": "macro",
    "economy": "macro",
    "business": "macro",
    "finance": "macro",
    "stocks": "stocks",
    "stockmarket": "stocks",
    "investing": "stocks",
    "securityanalysis": "stocks",
    "valueinvesting": "stocks",
    "options": "stocks",
    "daytrading": "stocks",
    "algotrading": "stocks",
    "quant": "stocks",
}

SUBREDDIT_FALLBACK_TITLES = {
    "stocks": "Market leadership is concentrated in liquid large-cap equities while Reddit feed recovery is in progress.",
    "stockmarket": "US equity risk appetite remains concentrated in the index-heavy names while Reddit ingestion recovers.",
    "investing": "Quality and balance-sheet strength remain the cleaner fallback lens while Reddit signal recovery is underway.",
    "securityanalysis": "Fundamental conviction remains more useful than headline chasing while Reddit feed recovery is underway.",
    "valueinvesting": "Defensive quality and valuation discipline remain the cleaner fallback posture while Reddit feed recovery is underway.",
    "options": "Options flow matters most when concentrated in liquid large-cap names during Reddit feed recovery.",
    "daytrading": "Short-term trading focus remains best kept on liquid names with clean intraday participation while Reddit feed recovery is underway.",
    "algotrading": "Systematic flow is more likely to cluster around liquid index leaders while Reddit signal recovery is underway.",
    "quant": "Factor leadership and liquidity remain the cleanest fallback lens while Reddit feed recovery is underway.",
    "economics": "Macro remains the dominant fallback lens while Reddit throttling persists; watch inflation, rates, and policy headlines.",
    "economy": "Macro and consumer-sensitivity remain the key fallback themes while Reddit feed recovery is underway.",
    "business": "Corporate and macro headline sensitivity remain the cleanest fallback focus while Reddit feed recovery is underway.",
    "finance": "Financial conditions and rate sensitivity remain the fallback focus while Reddit feed recovery is underway.",
    "worldnews": "Global event risk remains the clearest fallback theme while Reddit throttling persists; watch commodities and rates first.",
    "geopolitics": "Geopolitical spillover remains the fallback focus while Reddit feed recovery is underway.",
    "energy": "Energy supply and policy headlines remain the cleanest fallback theme while Reddit feed recovery is underway.",
    "oil": "Oil-sensitive names remain the clearest fallback watch while Reddit signal recovery is underway.",
    "cryptocurrency": "Crypto remains a liquidity-and-regulation trade while Reddit feed recovery is underway.",
    "bitcoin": "Bitcoin remains a macro-liquidity and ETF-sensitivity trade while Reddit feed recovery is underway.",
    "ethereum": "Ethereum remains a liquidity and regulatory-sensitivity trade while Reddit feed recovery is underway.",
    "ethtrader": "Ethereum-linked risk appetite remains headline-driven while Reddit feed recovery is underway.",
    "cryptomarkets": "Crypto market breadth remains the main fallback watch while Reddit feed recovery is underway.",
}


def normalize_subreddit_name(value: str | None) -> str:
    return str(value or "").strip().replace("r/", "").lower()


def _is_valid_market_theme(value: str) -> bool:
    return bool(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,39}", value))


def filter_allowed_market_subreddits(values: Sequence[str]) -> list[str]:
    filtered: list[str] = []
    seen: set[str] = set()
    for value in values:
        cleaned = normalize_subreddit_name(value)
        if not cleaned or not _is_valid_market_theme(cleaned) or cleaned in seen:
            continue
        seen.add(cleaned)
        filtered.append(cleaned)
    return filtered


@dataclass(slots=True)
class RedditPost:
    """Normalized Reddit post payload used across backend modules."""

    post_id: str
    title: str
    body_text: str
    subreddit: str
    username: str
    score: int
    comment_count: int
    thumbnail_url: Optional[str]
    article_link: str
    permalink: str
    post_url: str
    created_utc: float
    created_at_iso: str
    signal_score: float
    ai_summary: str = ""
    ai_sector: str = ""
    ai_reason: str = ""
    ai_confidence: float = 0.0
    ai_market_relevant: bool = True
    ai_tickers: tuple[str, ...] = ()


class RedditScraper:
    """Fetches posts from selected subreddits and normalizes important fields."""

    WINDOW_SECONDS = 86_400  # rolling 24h window

    def __init__(
        self,
        client_id: str | None,
        client_secret: str | None,
        user_agent: str,
    ) -> None:
        self.user_agent = user_agent
        self.reddit: praw.Reddit | None = None
        self.http = build_opener(ProxyHandler({}))
        self.last_fetch_error = ""
        self._fetch_errors: list[str] = []

        if client_id:
            self.reddit = praw.Reddit(
                client_id=client_id,
                client_secret=client_secret or "",
                user_agent=user_agent,
                ratelimit_seconds=5,
            )
            self.reddit.read_only = True

    def fetch_posts(
        self,
        subreddits: Sequence[str],
        limit_per_source: int = 200,
        post_limit: int = 20,
    ) -> list[RedditPost]:
        self.last_fetch_error = ""
        self._fetch_errors = []
        if self.reddit is not None:
            try:
                posts = self._fetch_posts_via_praw(subreddits, limit_per_source, post_limit)
                if posts:
                    self.last_fetch_error = ""
                    return posts
            except Exception as exc:
                self.last_fetch_error = str(exc)

        news_posts = self._fetch_posts_via_news_feeds(subreddits, post_limit)
        if news_posts:
            self.last_fetch_error = ""
            return news_posts

        self.last_fetch_error = "No live market articles were available for the current watchlist."
        return []

    def _fetch_posts_via_praw(
        self,
        subreddits: Sequence[str],
        limit_per_source: int,
        post_limit: int,
    ) -> list[RedditPost]:
        now_ts = datetime.now(timezone.utc).timestamp()
        strict_posts: dict[str, RedditPost] = {}
        relaxed_posts: dict[str, RedditPost] = {}

        for subreddit_name in subreddits:
            cleaned = subreddit_name.strip()
            if not cleaned:
                continue

            subreddit = self.reddit.subreddit(cleaned)
            source_streams = (
                subreddit.new(limit=limit_per_source),
                subreddit.hot(limit=limit_per_source),
                subreddit.top(time_filter="day", limit=limit_per_source),
            )

            for stream in source_streams:
                for submission in stream:
                    if (now_ts - float(submission.created_utc)) > self.WINDOW_SECONDS:
                        continue

                    strict_candidate = self._normalize_submission(submission, strict=True)
                    if strict_candidate is not None:
                        existing = strict_posts.get(strict_candidate.post_id)
                        if existing is None or strict_candidate.signal_score > existing.signal_score:
                            strict_posts[strict_candidate.post_id] = strict_candidate

                    relaxed_candidate = self._normalize_submission(submission, strict=False)
                    if relaxed_candidate is not None:
                        existing = relaxed_posts.get(relaxed_candidate.post_id)
                        if existing is None or relaxed_candidate.signal_score > existing.signal_score:
                            relaxed_posts[relaxed_candidate.post_id] = relaxed_candidate

        ranked_posts = sorted(
            (strict_posts or relaxed_posts).values(),
            key=lambda post: (post.signal_score, post.created_utc),
            reverse=True,
        )
        return ranked_posts[:post_limit]

    def _fetch_posts_via_public_json(
        self,
        subreddits: Sequence[str],
        limit_per_source: int,
        post_limit: int,
    ) -> list[RedditPost]:
        now_ts = datetime.now(timezone.utc).timestamp()
        strict_posts: dict[str, RedditPost] = {}
        relaxed_posts: dict[str, RedditPost] = {}

        normalized_subreddits = [
            normalize_subreddit_name(item) for item in subreddits if normalize_subreddit_name(item)
        ]
        if not normalized_subreddits:
            return []

        joined_subreddits = "+".join(quote(item) for item in normalized_subreddits)
        source_limit = min(max(post_limit * 3, 25), PUBLIC_JSON_LIMIT)

        for sort in PUBLIC_JSON_SOURCES:
            query = f"/r/{joined_subreddits}/{sort}.json?limit={source_limit}&raw_json=1"
            payload = None
            for base_url in PUBLIC_JSON_BASE_URLS:
                payload = self._fetch_json(f"{base_url}{query}")
                if payload is not None:
                    break
            if payload is None:
                continue

            children = payload.get("data", {}).get("children", [])
            for child in children:
                data = child.get("data", {})
                created_utc = float(data.get("created_utc") or 0)
                subreddit_name = normalize_subreddit_name(data.get("subreddit", ""))
                if (
                    not subreddit_name
                    or subreddit_name not in normalized_subreddits
                    or created_utc <= 0
                    or (now_ts - created_utc) > self.WINDOW_SECONDS
                ):
                    continue

                strict_candidate = self._normalize_submission_dict(
                    data, subreddit_name, sort, strict=True
                )
                if strict_candidate is not None:
                    existing = strict_posts.get(strict_candidate.post_id)
                    if existing is None or strict_candidate.signal_score > existing.signal_score:
                        strict_posts[strict_candidate.post_id] = strict_candidate

                relaxed_candidate = self._normalize_submission_dict(
                    data, subreddit_name, sort, strict=False
                )
                if relaxed_candidate is not None:
                    existing = relaxed_posts.get(relaxed_candidate.post_id)
                    if existing is None or relaxed_candidate.signal_score > existing.signal_score:
                        relaxed_posts[relaxed_candidate.post_id] = relaxed_candidate

        ranked_posts = sorted(
            (strict_posts or relaxed_posts).values(),
            key=lambda post: (post.signal_score, post.created_utc),
            reverse=True,
        )
        return ranked_posts[:post_limit]

    def _fetch_posts_via_news_feeds(
        self,
        subreddits: Sequence[str],
        post_limit: int,
    ) -> list[RedditPost]:
        now_ts = datetime.now(timezone.utc).timestamp()
        watched = [normalize_subreddit_name(item) for item in subreddits if normalize_subreddit_name(item)]
        strict_posts: dict[str, RedditPost] = {}
        relaxed_posts: dict[str, RedditPost] = {}

        for source_name, feed_url in MARKET_NEWS_RSS_FEEDS:
            payload = self._fetch_text(feed_url)
            if not payload:
                continue
            for candidate in self._parse_rss_items(payload, source_name, feed_url, now_ts, watched):
                if (now_ts - candidate.created_utc) > self.WINDOW_SECONDS:
                    continue
                if not self._is_news_relevant_post(
                    title=candidate.title,
                    subreddit=candidate.subreddit,
                    article_link=candidate.article_link,
                    body_text=candidate.body_text,
                    strict=True,
                ):
                    continue
                existing = strict_posts.get(candidate.post_id)
                if existing is None or candidate.signal_score > existing.signal_score:
                    strict_posts[candidate.post_id] = candidate

        query_terms = self._watchlist_news_queries(subreddits)
        for watched_theme, query in query_terms:
            payload = self._fetch_text(self._google_news_feed_url(query))
            if not payload:
                continue
            for candidate in self._parse_rss_items(
                payload,
                "Google News",
                "",
                now_ts,
                [watched_theme],
                forced_theme=watched_theme,
            ):
                if (now_ts - candidate.created_utc) > self.WINDOW_SECONDS:
                    continue
                direct_watch_match = self._is_direct_watch_match(
                    candidate.title,
                    candidate.body_text,
                    watched_theme,
                )
                strict_match = self._is_news_relevant_post(
                    title=candidate.title,
                    subreddit=candidate.subreddit,
                    article_link=candidate.article_link,
                    body_text=candidate.body_text,
                    strict=True,
                )
                relaxed_match = self._is_news_relevant_post(
                    title=candidate.title,
                    subreddit=candidate.subreddit,
                    article_link=candidate.article_link,
                    body_text=candidate.body_text,
                    strict=False,
                )
                if direct_watch_match or strict_match:
                    existing = strict_posts.get(candidate.post_id)
                    if existing is None or candidate.signal_score > existing.signal_score:
                        strict_posts[candidate.post_id] = candidate
                elif relaxed_match:
                    existing = relaxed_posts.get(candidate.post_id)
                    if existing is None or candidate.signal_score > existing.signal_score:
                        relaxed_posts[candidate.post_id] = candidate

        ranked_posts = sorted(
            (strict_posts or relaxed_posts).values(),
            key=lambda post: (post.signal_score, post.created_utc),
            reverse=True,
        )
        return ranked_posts[:post_limit]

    def search_subreddits(self, query: str, limit: int = 8) -> list[str]:
        cleaned = normalize_subreddit_name(query)
        if not cleaned:
            return []

        def starts_like(name: str) -> bool:
            return any(part.startswith(cleaned) for part in name.split())

        prefix_matches = [
            name for name in MARKET_SUBREDDIT_CATALOG if starts_like(name.lower())
        ]
        contains_matches = [
            name
            for name in MARKET_SUBREDDIT_CATALOG
            if cleaned in name.lower() and name not in prefix_matches
        ]

        matches = prefix_matches if prefix_matches else contains_matches
        matches.sort()
        return matches[:limit]

    def _fetch_json(self, url: str) -> dict[str, Any] | None:
        request = Request(
            url,
            headers={
                "User-Agent": self.user_agent,
                "Accept": "application/json",
            },
        )
        try:
            with self.http.open(request, timeout=10) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            self._remember_fetch_error(f"HTTP {exc.code} from {urlparse(url).netloc}")
            return None
        except URLError as exc:
            self._remember_fetch_error(str(exc))
            return None
        except Exception as exc:
            self._remember_fetch_error(str(exc))
            return None

    def _fetch_text(self, url: str) -> str | None:
        request = Request(
            url,
            headers={
                "User-Agent": self.user_agent,
                "Accept": "application/rss+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5",
            },
        )
        try:
            with self.http.open(request, timeout=10) as response:
                return response.read().decode("utf-8", errors="replace")
        except HTTPError as exc:
            self._remember_fetch_error(f"HTTP {exc.code} from {urlparse(url).netloc}")
            return None
        except URLError as exc:
            self._remember_fetch_error(str(exc))
            return None
        except Exception as exc:
            self._remember_fetch_error(str(exc))
            return None

    def _remember_fetch_error(self, message: str) -> None:
        cleaned = str(message or "").strip()
        if cleaned:
            self._fetch_errors.append(cleaned)

    def _build_emergency_posts(
        self,
        subreddits: Sequence[str],
        post_limit: int,
    ) -> list[RedditPost]:
        normalized = [normalize_subreddit_name(item) for item in subreddits if normalize_subreddit_name(item)]
        if not normalized:
            return []

        now_ts = datetime.now(timezone.utc).timestamp()
        posts: list[RedditPost] = []
        for idx, subreddit_name in enumerate(normalized):
            theme = EMERGENCY_THEME_MAP.get(subreddit_name, "macro")
            theme_titles = EMERGENCY_SIGNAL_TEMPLATES.get(theme, EMERGENCY_SIGNAL_TEMPLATES["macro"])
            title = SUBREDDIT_FALLBACK_TITLES.get(
                subreddit_name,
                theme_titles[idx % len(theme_titles)],
            )
            created_utc = now_ts - (idx * 1_200)
            subreddit_url = f"https://reddit.com/r/{subreddit_name}/"
            posts.append(
                RedditPost(
                    post_id=f"fallback-{subreddit_name}-{idx}",
                    title=title,
                    body_text="",
                    subreddit=subreddit_name,
                    username="signal_monitor",
                    score=max(300 - (idx * 35), 80),
                    comment_count=max(90 - (idx * 10), 18),
                    thumbnail_url=None,
                    article_link=subreddit_url,
                    permalink="",
                    post_url=subreddit_url,
                    created_utc=created_utc,
                    created_at_iso=datetime.fromtimestamp(created_utc, tz=timezone.utc).isoformat(),
                    signal_score=float(max(500 - (idx * 40), 150)),
                    ai_summary=(
                        f"Reddit public feeds are temporarily throttled, so this fallback keeps the dashboard alive "
                        f"around the {theme} theme until live Reddit ingestion resumes."
                    ),
                    ai_sector=theme,
                    ai_reason=self.last_fetch_error or "Reddit public feeds unavailable",
                    ai_confidence=0.0,
                    ai_market_relevant=True,
                    ai_tickers=(),
                )
            )

        return posts[:post_limit]

    def _watchlist_news_queries(self, subreddits: Sequence[str]) -> list[tuple[str, str]]:
        queries: list[tuple[str, str]] = []
        seen: set[tuple[str, str]] = set()
        for subreddit_name in subreddits:
            cleaned = normalize_subreddit_name(subreddit_name)
            if not cleaned:
                continue
            for query in self._build_watch_queries(cleaned):
                query_key = (cleaned, query)
                if query_key in seen:
                    continue
                seen.add(query_key)
                queries.append(query_key)

        if not queries:
            queries.extend(
                [
                    ("stocks", self._build_watch_queries("stocks")[0]),
                    ("economics", self._build_watch_queries("economics")[0]),
                    ("energy", self._build_watch_queries("energy")[0]),
                    ("cryptocurrency", self._build_watch_queries("cryptocurrency")[0]),
                ]
            )

        return queries[:12]

    def _build_watch_queries(self, theme: str) -> list[str]:
        spaced = theme.replace("-", " ").strip()
        return [
            (
                f"\"{spaced}\" AND "
                "(market OR stock OR stocks OR company OR earnings OR finance OR business "
                "OR revenue OR guidance OR ceo OR analyst OR shares)"
            ),
            (
                f"\"{spaced}\" AND "
                "(profit OR forecast OR demand OR sales OR product OR cloud OR advertising OR ai)"
            ),
            f"\"{spaced}\"",
        ]

    def _google_news_feed_url(self, query: str) -> str:
        full_query = f"({query}) ({GOOGLE_NEWS_OUTLET_FILTER}) when:1d"
        return GOOGLE_NEWS_RSS_TEMPLATE.format(query=quote(full_query))

    def _parse_rss_items(
        self,
        payload: str,
        source_name: str,
        fallback_link: str,
        now_ts: float,
        watched_subreddits: Sequence[str],
        forced_theme: str | None = None,
    ) -> list[RedditPost]:
        try:
            root = ET.fromstring(payload)
        except ET.ParseError:
            return []

        posts: list[RedditPost] = []
        for item in root.findall(".//item"):
            title = self._clean_feed_text(item.findtext("title"))
            link = self._clean_feed_text(item.findtext("link")) or fallback_link
            if not title or not link:
                continue

            source_label = self._extract_feed_source(item, source_name)
            body_text = self._clean_feed_text(item.findtext("description"))
            published_ts, published_iso = self._parse_feed_pubdate(item.findtext("pubDate"), now_ts)
            match_text = self._normalize_text(f"{title} {body_text}")
            if forced_theme and not self._matches_watch_theme(match_text, forced_theme):
                continue

            assigned_theme = forced_theme or self._infer_watch_theme(title, body_text, watched_subreddits)
            if not assigned_theme:
                continue

            score = self._estimate_article_score(title, body_text, published_ts, now_ts)
            comments = max(int(score // 4), 0)
            signal_score = round((score * 0.7) + (comments * 0.3), 2)
            digest = hashlib.sha1(f"{link}|{title}".encode("utf-8")).hexdigest()[:16]

            posts.append(
                RedditPost(
                    post_id=f"news-{digest}",
                    title=self._strip_source_suffix(title, source_label),
                    body_text=body_text,
                    subreddit=assigned_theme,
                    username=source_label,
                    score=score,
                    comment_count=comments,
                    thumbnail_url=None,
                    article_link=link,
                    permalink=link,
                    post_url=link,
                    created_utc=published_ts,
                    created_at_iso=published_iso,
                    signal_score=signal_score,
                )
            )

        return posts

    def _infer_watch_theme(
        self,
        title: str,
        body_text: str,
        watched_subreddits: Sequence[str],
    ) -> str | None:
        haystack = self._normalize_text(f"{title} {body_text}")
        watched = [item for item in watched_subreddits if item]
        if not watched:
            watched = ["stocks", "investing", "economics", "cryptocurrency"]

        for theme in watched:
            if self._matches_watch_theme(haystack, theme):
                return theme

        return None

    def _matches_watch_theme(self, haystack: str, theme: str) -> bool:
        for alias in self._watch_theme_aliases(theme):
            if f" {alias} " in f" {haystack} ":
                return True
        return False

    def _is_direct_watch_match(self, title: str, body_text: str, theme: str) -> bool:
        haystack = self._normalize_text(f"{title} {body_text}")
        if not self._matches_watch_theme(haystack, theme):
            return False

        hard_block_hits = self._count_keywords(haystack, HARD_BLOCK_KEYWORDS)
        spam_hits = self._count_keywords(haystack, DISCUSSION_OR_SPAM_KEYWORDS)
        return hard_block_hits == 0 and spam_hits == 0

    def _watch_theme_aliases(self, theme: str) -> tuple[str, ...]:
        normalized = normalize_subreddit_name(theme)
        if not normalized:
            return ()

        aliases = {
            normalized,
            normalized.replace("-", " "),
        }
        if normalized.endswith("s") and len(normalized) > 4:
            aliases.add(normalized[:-1])

        compact = normalized.replace("-", "")
        if compact and compact != normalized:
            aliases.add(compact)

        return tuple(alias for alias in aliases if alias)

    @staticmethod
    def _parse_feed_pubdate(raw_value: str | None, fallback_ts: float) -> tuple[float, str]:
        try:
            if raw_value:
                parsed = parsedate_to_datetime(raw_value)
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                timestamp = parsed.timestamp()
                return timestamp, parsed.astimezone(timezone.utc).isoformat()
        except Exception:
            pass

        return fallback_ts, datetime.fromtimestamp(fallback_ts, tz=timezone.utc).isoformat()

    @staticmethod
    def _clean_feed_text(value: str | None) -> str:
        raw = html.unescape(str(value or ""))
        stripped = re.sub(r"<[^>]+>", " ", raw)
        compact = " ".join(stripped.split())
        return compact.strip()

    def _extract_feed_source(self, item: ET.Element, fallback: str) -> str:
        source_element = item.find("source")
        source_label = self._clean_feed_text(source_element.text if source_element is not None else "")
        title = self._clean_feed_text(item.findtext("title"))
        if source_label:
            return source_label

        if " - " in title:
            possible_source = title.rsplit(" - ", 1)[-1].strip()
            if 1 < len(possible_source) < 40:
                return possible_source

        return fallback

    @staticmethod
    def _source_slug(value: str) -> str:
        slug = re.sub(r"[^a-z0-9]+", "-", str(value or "").lower()).strip("-")
        return slug or "markets"

    @staticmethod
    def _strip_source_suffix(title: str, source_label: str) -> str:
        cleaned_title = str(title or "").strip()
        cleaned_source = str(source_label or "").strip()
        suffix = f" - {cleaned_source}"
        if cleaned_source and cleaned_title.endswith(suffix):
            return cleaned_title[: -len(suffix)].rstrip()
        return cleaned_title

    def _estimate_article_score(
        self,
        title: str,
        body_text: str,
        published_ts: float,
        now_ts: float,
    ) -> int:
        normalized_title = self._normalize_text(title)
        normalized_body = self._normalize_text(body_text)
        market_hits = self._count_keywords(normalized_title, MARKET_IMPACT_KEYWORDS)
        market_hits += self._count_keywords(normalized_body, MARKET_IMPACT_KEYWORDS)
        event_hits = self._count_keywords(normalized_title, MARKET_EVENT_KEYWORDS)
        event_hits += self._count_keywords(normalized_body, MARKET_EVENT_KEYWORDS)
        age_hours = max((now_ts - published_ts) / 3600.0, 0.0)
        freshness_bonus = max(0, 48 - int(age_hours * 4))
        return max(12, 40 + (market_hits * 18) + (event_hits * 10) + freshness_bonus)

    @staticmethod
    def _slugify_title(title: str) -> str:
        cleaned = "".join(ch.lower() if ch.isalnum() else "-" for ch in (title or ""))
        compact = "-".join(part for part in cleaned.split("-") if part)
        return compact[:80] or "post"

    def _canonical_post_url(self, submission: Submission, permalink: str) -> str:
        if permalink and "/comments/" in permalink:
            return f"https://reddit.com{permalink}"

        subreddit = str(submission.subreddit)
        slug = self._slugify_title(submission.title)
        return f"https://reddit.com/r/{subreddit}/comments/{submission.id}/{slug}/"

    def _normalize_submission(
        self,
        submission: Submission,
        strict: bool = True,
    ) -> RedditPost | None:
        article_link = submission.url or ""
        flair_text = getattr(submission, "link_flair_text", None)
        if not self._is_news_relevant_post(
            title=submission.title,
            subreddit=str(submission.subreddit),
            article_link=article_link,
            flair_text=flair_text,
            strict=strict,
        ):
            return None

        author_name = submission.author.name if submission.author else "[deleted]"
        created_at_iso = datetime.fromtimestamp(
            submission.created_utc, tz=timezone.utc
        ).isoformat()
        upvotes = int(max(submission.score, 0))
        comment_count = int(max(submission.num_comments, 0))
        signal_score = round((upvotes * 0.55) + (comment_count * 0.45), 2)

        permalink = submission.permalink or ""
        if permalink and not permalink.startswith("/"):
            permalink = f"/{permalink}"
        post_url = self._canonical_post_url(submission, permalink)

        return RedditPost(
            post_id=submission.id,
            title=submission.title,
            body_text=(submission.selftext or "").strip(),
            subreddit=str(submission.subreddit),
            username=author_name,
            score=upvotes,
            comment_count=comment_count,
            thumbnail_url=self._extract_thumbnail_url(submission),
            article_link=article_link or post_url,
            permalink=permalink,
            post_url=post_url,
            created_utc=float(submission.created_utc),
            created_at_iso=created_at_iso,
            signal_score=signal_score,
        )

    def _normalize_submission_dict(
        self,
        submission: dict[str, Any],
        subreddit_fallback: str,
        _source: str,
        strict: bool = True,
    ) -> RedditPost | None:
        post_id = str(submission.get("id", "")).strip()
        title = str(submission.get("title", "")).strip()
        if not post_id or not title:
            return None

        subreddit = str(submission.get("subreddit", "")).strip() or subreddit_fallback
        username = str(submission.get("author", "")).strip() or "[deleted]"
        created_utc = float(submission.get("created_utc") or 0)
        if created_utc <= 0:
            return None

        created_at_iso = datetime.fromtimestamp(created_utc, tz=timezone.utc).isoformat()
        upvotes = int(max(int(submission.get("score") or 0), 0))
        comment_count = int(max(int(submission.get("num_comments") or 0), 0))
        signal_score = round((upvotes * 0.55) + (comment_count * 0.45), 2)

        permalink = str(submission.get("permalink", "")).strip()
        if permalink and not permalink.startswith("/"):
            permalink = f"/{permalink}"

        post_url = self._canonical_post_url_from_values(
            subreddit=subreddit,
            post_id=post_id,
            title=title,
            permalink=permalink,
        )
        article_link = str(submission.get("url", "")).strip() or post_url
        flair_text = submission.get("link_flair_text")

        if not self._is_news_relevant_post(
            title=title,
            subreddit=subreddit,
            article_link=article_link,
            flair_text=flair_text,
            strict=strict,
        ):
            return None

        return RedditPost(
            post_id=post_id,
            title=title,
            body_text=str(submission.get("selftext", "") or "").strip(),
            subreddit=subreddit,
            username=username,
            score=upvotes,
            comment_count=comment_count,
            thumbnail_url=self._extract_thumbnail_url_from_dict(submission),
            article_link=article_link,
            permalink=permalink,
            post_url=post_url,
            created_utc=created_utc,
            created_at_iso=created_at_iso,
            signal_score=signal_score,
        )

    def _canonical_post_url_from_values(
        self,
        subreddit: str,
        post_id: str,
        title: str,
        permalink: str,
    ) -> str:
        if permalink and "/comments/" in permalink:
            return f"https://reddit.com{permalink}"

        slug = self._slugify_title(title)
        return f"https://reddit.com/r/{subreddit}/comments/{post_id}/{slug}/"

    @staticmethod
    def _extract_thumbnail_url(submission: Submission) -> Optional[str]:
        preview = getattr(submission, "preview", None)
        if isinstance(preview, dict):
            try:
                source_url = preview["images"][0]["source"]["url"]
                if source_url:
                    return html.unescape(source_url)
            except (KeyError, IndexError, TypeError):
                pass

            try:
                resolution_url = preview["images"][0]["resolutions"][-1]["url"]
                if resolution_url:
                    return html.unescape(resolution_url)
            except (KeyError, IndexError, TypeError):
                pass

        url = getattr(submission, "url", "")
        if isinstance(url, str) and url.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".gif")):
            return html.unescape(url)

        thumbnail = getattr(submission, "thumbnail", "")
        if isinstance(thumbnail, str) and thumbnail.startswith("http"):
            return html.unescape(thumbnail)

        return None

    @staticmethod
    def _normalize_text(value: str | None) -> str:
        raw = str(value or "").strip().lower()
        if not raw:
            return ""
        clean = "".join(ch if ch.isalnum() else " " for ch in raw)
        return " ".join(clean.split())

    def _count_keywords(self, text: str, keywords: Sequence[str]) -> int:
        padded = f" {text} "
        return sum(1 for keyword in keywords if f" {keyword} " in padded)

    def _is_external_news_link(self, url: str | None) -> bool:
        raw = str(url or "").strip()
        if not raw:
            return False
        try:
            parsed = urlparse(raw if "://" in raw else f"https://reddit.com{raw}")
        except Exception:
            return False

        host = (parsed.hostname or "").lower()
        if not host or host in NON_NEWS_MEDIA_HOSTS or host.endswith(".reddit.com"):
            return False

        path = (parsed.path or "").lower()
        if path.endswith(NON_NEWS_MEDIA_EXTENSIONS):
            return False

        return True

    def _is_news_relevant_post(
        self,
        title: str,
        subreddit: str,
        article_link: str | None,
        body_text: str | None = None,
        flair_text: str | None = None,
        strict: bool = True,
    ) -> bool:
        normalized_title = self._normalize_text(title)
        normalized_body = self._normalize_text(body_text)
        normalized_flair = self._normalize_text(flair_text)
        if not normalized_title:
            return False

        hard_block_hits = self._count_keywords(normalized_title, HARD_BLOCK_KEYWORDS)
        hard_block_hits += self._count_keywords(normalized_body, HARD_BLOCK_KEYWORDS)
        hard_block_hits += self._count_keywords(normalized_flair, HARD_BLOCK_KEYWORDS)
        if hard_block_hits > 0:
            return False

        spam_hits = self._count_keywords(normalized_title, DISCUSSION_OR_SPAM_KEYWORDS)
        spam_hits += self._count_keywords(normalized_body, DISCUSSION_OR_SPAM_KEYWORDS)
        spam_hits += self._count_keywords(normalized_flair, DISCUSSION_OR_SPAM_KEYWORDS)
        if spam_hits > 0:
            return False

        market_hits = self._count_keywords(normalized_title, MARKET_IMPACT_KEYWORDS)
        market_hits += self._count_keywords(normalized_body, MARKET_IMPACT_KEYWORDS)
        market_hits += self._count_keywords(normalized_flair, MARKET_IMPACT_KEYWORDS)
        if market_hits == 0:
            return False

        event_hits = self._count_keywords(normalized_title, MARKET_EVENT_KEYWORDS)
        event_hits += self._count_keywords(normalized_body, MARKET_EVENT_KEYWORDS)
        event_hits += self._count_keywords(normalized_flair, MARKET_EVENT_KEYWORDS)
        has_external_news_link = self._is_external_news_link(article_link)
        subreddit_is_market = normalize_subreddit_name(subreddit) in ALLOWED_MARKET_SUBREDDITS

        if strict:
            return market_hits >= 1 and (
                (has_external_news_link and (event_hits >= 1 or market_hits >= 1))
                or market_hits >= 2
                or (subreddit_is_market and event_hits >= 1)
            )

        return market_hits >= 1 and (
            has_external_news_link
            or event_hits >= 1
            or market_hits >= 2
            or subreddit_is_market
        )

    @staticmethod
    def _extract_thumbnail_url_from_dict(submission: dict[str, Any]) -> Optional[str]:
        preview = submission.get("preview")
        if isinstance(preview, dict):
            try:
                source_url = preview["images"][0]["source"]["url"]
                if source_url:
                    return html.unescape(source_url)
            except (KeyError, IndexError, TypeError):
                pass

            try:
                resolution_url = preview["images"][0]["resolutions"][-1]["url"]
                if resolution_url:
                    return html.unescape(resolution_url)
            except (KeyError, IndexError, TypeError):
                pass

        url = submission.get("url", "")
        if isinstance(url, str) and url.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".gif")):
            return html.unescape(url)

        thumbnail = submission.get("thumbnail", "")
        if isinstance(thumbnail, str) and thumbnail.startswith("http"):
            return html.unescape(thumbnail)

        return None
