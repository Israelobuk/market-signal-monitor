"""FastAPI server that streams market signal alerts over WebSocket."""

from __future__ import annotations

import asyncio
import os
import random
import re
import time
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from market_data import fetch_market_sets
from ollama_enricher import OllamaEnricher
from ollama_enricher import enrich_posts_with_fallback
from reddit_scraper import (
    MARKET_SUBREDDIT_CATALOG,
    RedditPost,
    RedditScraper,
    filter_allowed_market_subreddits,
)
from signal_engine import SignalConfig, SignalEngine

load_dotenv()


DEFAULT_SUBREDDITS = ["stocks", "investing", "economics", "cryptocurrency"]


def _parse_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


SUBREDDITS = [
    s.strip()
    for s in os.getenv("SUBREDDITS", ",".join(DEFAULT_SUBREDDITS)).split(",")
    if s.strip()
]
POSTS_PER_SUBREDDIT = int(os.getenv("POSTS_PER_SUBREDDIT", "200"))
TOP_POSTS_LIMIT = int(os.getenv("TOP_POSTS_LIMIT", "20"))
POLL_SECONDS = float(os.getenv("POLL_SECONDS", "5"))
USE_MOCK_DATA = _parse_bool(os.getenv("USE_MOCK_DATA"), default=False)
REDDIT_FETCH_CACHE_SECONDS = float(os.getenv("REDDIT_FETCH_CACHE_SECONDS", "20"))
OLLAMA_ENABLED = _parse_bool(os.getenv("OLLAMA_ENABLED"), default=False)
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.1:8b").strip() or "llama3.1:8b"
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").strip() or "http://127.0.0.1:11434"
OLLAMA_TIMEOUT_SECONDS = float(os.getenv("OLLAMA_TIMEOUT_SECONDS", "20"))
OLLAMA_CHAT_TIMEOUT_SECONDS = float(os.getenv("OLLAMA_CHAT_TIMEOUT_SECONDS", "8"))
MARKET_CHAT_TIMEOUT_SECONDS = float(os.getenv("MARKET_CHAT_TIMEOUT_SECONDS", "1.5"))
OLLAMA_MIN_CONFIDENCE = float(os.getenv("OLLAMA_MIN_CONFIDENCE", "0.55"))
CORS_ALLOW_ORIGINS = [
    origin.strip()
    for origin in os.getenv("CORS_ALLOW_ORIGINS", "http://127.0.0.1:5173,http://localhost:5173").split(",")
    if origin.strip()
]

signal_engine = SignalEngine(
    SignalConfig(
        top_posts_per_cycle=TOP_POSTS_LIMIT,
        max_processed_posts=int(os.getenv("MAX_PROCESSED_POSTS", "10000")),
    )
)


class AlertHub:
    """Tracks active websocket clients and broadcasts alert events."""

    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._clients.add(websocket)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._clients.discard(websocket)

    async def broadcast(self, payload: dict) -> None:
        async with self._lock:
            clients = list(self._clients)

        async def send_payload(websocket: WebSocket) -> WebSocket | None:
            try:
                await asyncio.wait_for(websocket.send_json(payload), timeout=2)
                return None
            except Exception:
                return websocket

        dead_clients = [
            websocket
            for websocket in await asyncio.gather(
                *(send_payload(websocket) for websocket in clients)
            )
            if websocket is not None
        ]

        if dead_clients:
            async with self._lock:
                for websocket in dead_clients:
                    self._clients.discard(websocket)

    async def count(self) -> int:
        async with self._lock:
            return len(self._clients)


hub = AlertHub()
reddit_scraper: RedditScraper | None = None
ollama_enricher: OllamaEnricher | None = None
latest_posts: list[RedditPost] = []
latest_posts_lock = asyncio.Lock()
latest_reddit_error = ""
reddit_fetch_cache: dict[str, object] = {
    "subreddits": [],
    "fetched_at": 0.0,
    "posts": [],
}


def _normalize_subreddits(values: list[str] | None) -> list[str]:
    if values is None:
        fallback = filter_allowed_market_subreddits(SUBREDDITS)
        return fallback or list(DEFAULT_SUBREDDITS)

    normalized = filter_allowed_market_subreddits(values)
    return normalized


class WatchlistState:
    def __init__(self, initial_subreddits: list[str]) -> None:
        self._subreddits = _normalize_subreddits(initial_subreddits)
        self._lock = asyncio.Lock()

    async def get(self) -> list[str]:
        async with self._lock:
            return list(self._subreddits)

    async def set(self, subreddits: list[str]) -> list[str]:
        cleaned = _normalize_subreddits(subreddits)
        async with self._lock:
            self._subreddits = cleaned
            return list(self._subreddits)


watchlist_state = WatchlistState(SUBREDDITS)


class WatchlistPayload(BaseModel):
    subreddits: list[str]


class AssistantMessagePayload(BaseModel):
    role: str
    content: str


class AssistantChatPayload(BaseModel):
    message: str
    history: list[AssistantMessagePayload] = []


def _build_reddit_scraper() -> RedditScraper:
    client_id = os.getenv("REDDIT_CLIENT_ID")
    client_secret = os.getenv("REDDIT_CLIENT_SECRET")
    user_agent = os.getenv("REDDIT_USER_AGENT", "market-signal-monitor/0.1")

    def sanitize(value: str | None) -> str | None:
        cleaned = str(value or "").strip()
        if not cleaned:
            return None
        if cleaned.lower().startswith("your_"):
            return None
        return cleaned

    return RedditScraper(
        client_id=sanitize(client_id),
        client_secret=sanitize(client_secret),
        user_agent=user_agent,
    )


def _build_ollama_enricher() -> OllamaEnricher:
    return OllamaEnricher(
        base_url=OLLAMA_BASE_URL,
        model=OLLAMA_MODEL,
        timeout_seconds=OLLAMA_TIMEOUT_SECONDS,
        min_confidence=OLLAMA_MIN_CONFIDENCE,
    )


def _serialize_post(post: RedditPost) -> dict:
    return {
        "id": post.post_id,
        "title": post.title,
        "body_text": post.body_text,
        "subreddit": post.subreddit,
        "author": post.username,
        "username": post.username,
        "upvotes": post.score,
        "comments": post.comment_count,
        "comment_count": post.comment_count,
        "thumbnail_url": post.thumbnail_url,
        "image": post.thumbnail_url,
        "article_link": post.article_link,
        "permalink": post.permalink,
        "post_url": post.post_url,
        "created_utc": post.created_utc,
        "timestamp": post.created_at_iso,
        "signal_score": round(post.signal_score, 2),
        "ai_summary": post.ai_summary,
        "ai_sector": post.ai_sector,
        "ai_reason": post.ai_reason,
        "ai_confidence": round(post.ai_confidence, 3),
        "ai_market_relevant": post.ai_market_relevant,
        "ai_tickers": list(post.ai_tickers),
    }


async def _set_latest_posts(posts: list[RedditPost]) -> None:
    async with latest_posts_lock:
        latest_posts[:] = list(posts)


def _set_latest_reddit_error(value: str) -> None:
    global latest_reddit_error
    latest_reddit_error = str(value or "").strip()


def _get_latest_reddit_error() -> str:
    return latest_reddit_error


async def _get_latest_posts() -> list[dict]:
    async with latest_posts_lock:
        return [_serialize_post(post) for post in latest_posts]


async def _get_latest_post_objects() -> list[RedditPost]:
    async with latest_posts_lock:
        return list(latest_posts)


def _truncate_text(value: str, limit: int) -> str:
    compact = " ".join(str(value or "").split())
    return compact if len(compact) <= limit else f"{compact[: limit - 1].rstrip()}…"


def _format_context_post(post: RedditPost) -> str:
    ticker_text = f" | tickers: {', '.join(post.ai_tickers)}" if post.ai_tickers else ""
    sector_text = f" | sector: {post.ai_sector}" if post.ai_sector else ""
    summary_text = post.ai_summary or post.ai_reason or post.title
    return (
        f"- theme: {post.subreddit} | {post.created_at_iso} | score {post.score} | comments {post.comment_count}"
        f"{sector_text}{ticker_text}\n"
        f"  title: {_truncate_text(post.title, 180)}\n"
        f"  context: {_truncate_text(summary_text, 180)}"
    )


def _format_market_block(market_sets: dict) -> str:
    sections: list[str] = []
    for key, label in (
        ("popular", "Most popular"),
        ("volatile", "Most volatile"),
        ("pullbacks", "Pullbacks"),
    ):
        entries = market_sets.get(key) or []
        if not entries:
            continue
        lines = []
        for item in entries[:5]:
            ticker = str(item.get("ticker", "")).upper()
            change = item.get("change")
            if not ticker or change is None:
                continue
            lines.append(f"{ticker} {float(change):+.1f}%")
        if lines:
            sections.append(f"{label}: {', '.join(lines)}")

    return "\n".join(sections)


def _build_assistant_system_prompt(
    posts: list[RedditPost],
    market_sets: dict,
    tracked_subreddits: list[str],
) -> str:
    context_posts = posts[:4]
    posts_block = "\n".join(_format_context_post(post) for post in context_posts) or "- No recent posts"
    market_block = _format_market_block(market_sets) or "No current market mover snapshot available."
    subreddits_block = ", ".join(tracked_subreddits) or "none"

    return (
        "You are Signal AI, a context-aware market intelligence assistant inside a live dashboard.\n"
        "Speak like a quantitative analyst or market strategist: concise, practical, and grounded in evidence.\n"
        "Answer the user's question directly. Do not just restate the feed unless they explicitly ask for a recap.\n"
        "Use only the supplied context. If the context is insufficient, say that directly and explain what is missing.\n"
        "Do not claim certainty, do not promise returns, and do not present yourself as retraining on user input.\n"
        "When asked what to focus on or invest in, prioritize 1 to 3 watch items only if the context supports them.\n"
        "For each idea, explain:\n"
        "- the thesis in plain English\n"
        "- why the current context supports it\n"
        "- what confirms it\n"
        "- what invalidates it\n"
        "If the context is macro rather than ticker-specific, say that and discuss the sectors or risk factors instead of forcing stock picks.\n"
        "Do not invent tickers or sectors that are not supported by the supplied context.\n"
        "Never mention Reddit, subreddits, or r/ labels. Refer only to signals, themes, and current context.\n"
        "You may discuss scenario analysis and risk, but avoid personalized financial advice.\n\n"
        f"Tracked themes: {subreddits_block}\n"
        f"Current UTC time: {datetime.now(timezone.utc).isoformat()}\n\n"
        f"Recent signal context:\n{posts_block}\n\n"
        f"Current market snapshot:\n{market_block}\n"
    )


def _assistant_unavailable_reply() -> str:
    if not OLLAMA_ENABLED:
        return (
            f"Signal AI is set up to answer through the Ollama model layer only. "
            f"Turn `OLLAMA_ENABLED=true` in `backend/.env`, make sure `{OLLAMA_MODEL}` is available, "
            "and restart the backend."
        )

    return (
        f"Signal AI could not reach the Ollama model layer at {OLLAMA_BASE_URL}. "
        f"Start Ollama, confirm the `{OLLAMA_MODEL}` model is installed, and restart the backend if needed."
    )


def _sanitize_assistant_reply(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""

    replacements = (
        (r"\breddit signal context\b", "recent signal context"),
        (r"\breddit\b", "signal"),
        (r"\bsubreddits\b", "themes"),
        (r"\bsubreddit\b", "theme"),
    )
    for pattern, replacement in replacements:
        text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)

    text = re.sub(r"\br/[a-z0-9_]+\b", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s{2,}", " ", text).strip()
    return text


def _build_fast_assistant_reply(message: str, posts: list[RedditPost], tracked_themes: list[str]) -> str:
    lowered = message.lower().strip()
    context_posts = posts[:3]
    if not context_posts:
        tracked = ", ".join(tracked_themes[:6]) or "your tracked themes"
        return (
            f"I don't have enough live signal context yet to answer that well. "
            f"Right now I'm watching {tracked}. Give it a moment for fresh signals to load, then ask again."
        )

    sectors: list[str] = []
    tickers: list[str] = []
    titles: list[str] = []
    for post in context_posts:
        titles.append(post.title)
        if post.ai_sector and post.ai_sector not in sectors:
            sectors.append(post.ai_sector)
        for ticker in post.ai_tickers:
            if ticker not in tickers:
                tickers.append(ticker)

    lead_title = titles[0]
    lead_sector = sectors[0] if sectors else (context_posts[0].subreddit or "the active theme")
    lead_tickers = ", ".join(tickers[:3])

    if "which stocks" in lowered or "benefits" in lowered or "invest" in lowered:
        if lead_tickers:
            return (
                f"The first names I would watch from the current signal set are {lead_tickers}. "
                f"The setup is being driven mainly by {lead_sector}, and the strongest headline right now is "
                f"'{lead_title}'. I would treat these as watch items, not blind buys, and wait for follow-through."
            )
        return (
            f"The current flow looks more {lead_sector}-driven than stock-specific. "
            f"The lead signal is '{lead_title}', so I would focus on the sector and wait for cleaner company-level confirmation."
        )

    if "trade thesis" in lowered or "thesis" in lowered:
        return (
            f"The live thesis is that {lead_sector} is being moved by the current headline flow, led by '{lead_title}'. "
            f"If follow-through headlines confirm the move, the trade is continuation; if the news fades quickly, the move can unwind just as fast."
        )

    if "watch next" in lowered:
        return (
            f"Next I would watch whether new headlines reinforce '{lead_title}', whether other {lead_sector} stories start clustering, "
            f"and whether any company-specific names begin showing up instead of just macro signal flow."
        )

    if "break" in lowered or "invalidate" in lowered:
        return (
            f"What breaks this setup is the current signal flow losing follow-through. "
            f"If the headline behind '{lead_title}' gets walked back, contradicted, or ignored by the next few signals, the thesis weakens quickly."
        )

    return (
        f"The main thing happening right now is '{lead_title}', which is pushing attention toward {lead_sector}. "
        f"If you want, I can turn that into a stock watchlist, a trade thesis, or a risk checklist."
    )


def _mock_posts(subreddits: list[str]) -> list[RedditPost]:
    now = time.time()
    sample_titles = [
        "Breaking: Treasury yield surprise shakes markets",
        "Fed commentary sparks fresh volatility in tech names",
        "Energy stocks jump after supply-side headline",
        "Retail traders pile into mega-cap momentum trade",
        "Global index futures react to overnight macro data",
    ]

    posts: list[RedditPost] = []
    for idx, title in enumerate(sample_titles):
        score = random.randint(50, 1200)
        comments = random.randint(10, 450)
        subreddit = random.choice(subreddits or SUBREDDITS or ["news"])
        permalink = f"/r/{subreddit}/"
        post_url = f"https://reddit.com{permalink}"
        created_utc = now - random.randint(60, 600)
        signal_score = round((score * 0.55) + (comments * 0.45), 2)
        posts.append(
            RedditPost(
                post_id=f"mock-{int(now)}-{idx}",
                title=title,
                body_text="",
                subreddit=subreddit,
                username=f"mock_user_{idx}",
                score=score,
                comment_count=comments,
                thumbnail_url="https://www.redditstatic.com/desktop2x/img/favicon/android-icon-192x192.png",
                article_link=post_url,
                permalink=permalink,
                post_url=post_url,
                created_utc=created_utc,
                created_at_iso=datetime.fromtimestamp(created_utc, tz=timezone.utc).isoformat(),
                signal_score=signal_score,
            )
        )

    return posts


async def _fetch_current_posts(current_subreddits: list[str]) -> list[RedditPost]:
    global reddit_scraper, ollama_enricher
    normalized_subreddits = [item.strip().lower() for item in current_subreddits if item.strip()]
    cached_subreddits = reddit_fetch_cache.get("subreddits", [])
    cached_at = float(reddit_fetch_cache.get("fetched_at", 0.0))
    cached_posts = list(reddit_fetch_cache.get("posts", []))

    if (
        cached_posts
        and cached_subreddits == normalized_subreddits
        and (time.time() - cached_at) < REDDIT_FETCH_CACHE_SECONDS
    ):
        return cached_posts

    if USE_MOCK_DATA:
        posts = _mock_posts(current_subreddits)
        _set_latest_reddit_error("")
    else:
        if reddit_scraper is None:
            reddit_scraper = _build_reddit_scraper()
        posts = await asyncio.to_thread(
            reddit_scraper.fetch_posts,
            current_subreddits,
            POSTS_PER_SUBREDDIT,
            TOP_POSTS_LIMIT,
        )
        if posts:
            posts = enrich_posts_with_fallback(posts)

    current_subreddit_set = {item.lower() for item in current_subreddits}
    if current_subreddit_set:
        filtered_posts = [
            post for post in posts if post.subreddit.strip().lower() in current_subreddit_set
        ]
    else:
        filtered_posts = []

    if filtered_posts:
        _set_latest_reddit_error("")
        reddit_fetch_cache["subreddits"] = normalized_subreddits
        reddit_fetch_cache["fetched_at"] = time.time()
        reddit_fetch_cache["posts"] = list(filtered_posts)
        return filtered_posts

    if cached_posts and cached_subreddits == normalized_subreddits:
        _set_latest_reddit_error("")
        return cached_posts

    if not USE_MOCK_DATA and reddit_scraper is not None:
        _set_latest_reddit_error(reddit_scraper.last_fetch_error)

    return []


async def _broadcast_posts_snapshot(posts: list[RedditPost]) -> None:
    await _set_latest_posts(posts)
    await hub.broadcast(
        {
            "type": "posts_snapshot",
            "payload": {
                "posts": await _get_latest_posts(),
                "error": _get_latest_reddit_error(),
            },
        }
    )


async def _monitor_loop() -> None:
    while True:
        try:
            current_subreddits = await watchlist_state.get()
            posts = await _fetch_current_posts(current_subreddits)
            await _broadcast_posts_snapshot(posts)

            events = signal_engine.process_posts(posts)
            for event in events:
                await hub.broadcast({"type": "signal", "payload": event})

        except Exception as exc:
            print(f"[monitor-loop] error: {exc}")

        await asyncio.sleep(POLL_SECONDS)


@asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(_monitor_loop())
    try:
        yield
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


app = FastAPI(title="Market Signal Monitor API", lifespan=lifespan)

allow_all_origins = CORS_ALLOW_ORIGINS == ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOW_ORIGINS if not allow_all_origins else ["*"],
    allow_credentials=not allow_all_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict:
    active_subreddits = await watchlist_state.get()
    return {
        "status": "ok",
        "use_mock_data": USE_MOCK_DATA,
        "ollama_enabled": OLLAMA_ENABLED,
        "ollama_model": OLLAMA_MODEL if OLLAMA_ENABLED else "",
        "reddit_error": _get_latest_reddit_error(),
        "subreddits": active_subreddits,
        "top_posts_limit": TOP_POSTS_LIMIT,
        "connected_clients": await hub.count(),
        "posts_cached": len(await _get_latest_posts()),
    }


@app.get("/api/signals/latest")
async def latest_signals() -> dict:
    return {
        "posts": await _get_latest_posts(),
        "error": _get_latest_reddit_error(),
        "subreddits": await watchlist_state.get(),
    }


@app.post("/api/watchlist")
async def update_watchlist(payload: WatchlistPayload) -> dict:
    reddit_fetch_cache["subreddits"] = []
    reddit_fetch_cache["fetched_at"] = 0.0
    reddit_fetch_cache["posts"] = []
    active_subreddits = await watchlist_state.set(payload.subreddits)
    signal_engine.reset()
    posts = await _fetch_current_posts(active_subreddits)
    await _broadcast_posts_snapshot(posts)
    await hub.broadcast(
        {
            "type": "watchlist_updated",
            "payload": {
                "subreddits": active_subreddits,
            },
        }
    )
    return {"status": "ok", "subreddits": active_subreddits}


@app.get("/api/subreddits/search")
async def search_subreddits(q: str = "") -> dict:
    query = q.strip().lower()
    if not query:
        return {"results": []}

    def starts_like(name: str) -> bool:
        return any(part.startswith(query) for part in name.split())

    prefix_results = [
        name for name in MARKET_SUBREDDIT_CATALOG if starts_like(name.lower())
    ]
    contains_results = [
        name
        for name in MARKET_SUBREDDIT_CATALOG
        if query in name.lower() and name not in prefix_results
    ]
    results = sorted(prefix_results if prefix_results else contains_results)[:20]
    return {"results": results}


@app.get("/api/market-movers")
async def market_movers() -> dict:
    market_sets = await asyncio.to_thread(fetch_market_sets)
    return {"results": market_sets.get("popular", []), "sets": market_sets}


@app.post("/api/assistant/chat")
async def assistant_chat(payload: AssistantChatPayload) -> dict:
    global ollama_enricher

    latest_post_objects = await _get_latest_post_objects()
    tracked_subreddits = await watchlist_state.get()
    cleaned_message = payload.message.strip()

    provider = "fallback"
    reply = _build_fast_assistant_reply(
        cleaned_message,
        latest_post_objects,
        tracked_subreddits,
    )
    market_sets: dict = {}

    try:
        try:
            market_sets = await asyncio.wait_for(
                asyncio.to_thread(
                    fetch_market_sets,
                ),
                timeout=MARKET_CHAT_TIMEOUT_SECONDS,
            )
        except Exception:
            market_sets = {}

        cleaned_history = [
            {
                "role": item.role if item.role in {"user", "assistant"} else "user",
                "content": item.content.strip(),
            }
            for item in payload.history[-3:]
            if item.content.strip()
        ]

        system_prompt = _build_assistant_system_prompt(
            latest_post_objects,
            market_sets,
            tracked_subreddits,
        )

        if OLLAMA_ENABLED and cleaned_message:
            if ollama_enricher is None:
                ollama_enricher = _build_ollama_enricher()
            try:
                model_reply = await asyncio.wait_for(
                    asyncio.to_thread(
                        ollama_enricher.chat,
                        [
                            *cleaned_history,
                            {"role": "user", "content": cleaned_message},
                        ],
                        system_prompt,
                    ),
                    timeout=OLLAMA_CHAT_TIMEOUT_SECONDS,
                )
            except Exception:
                model_reply = None
            if model_reply:
                reply = _sanitize_assistant_reply(model_reply)
                provider = "ollama"
            elif not reply:
                reply = _assistant_unavailable_reply()
                provider = "unavailable"
    except Exception:
        if not reply:
            reply = "Signal AI hit a backend issue, but I can still answer once fresh signal context is available."
            provider = "unavailable"

    return {
        "reply": reply,
        "provider": provider,
        "context_count": len(latest_post_objects),
        "ollama_enabled": OLLAMA_ENABLED,
    }


@app.websocket("/ws/alerts")
async def alerts_socket(websocket: WebSocket) -> None:
    await hub.connect(websocket)
    active_subreddits = await watchlist_state.get()
    await websocket.send_json(
        {
            "type": "hello",
            "payload": {
                "message": "connected",
                "subreddits": active_subreddits,
                "poll_seconds": POLL_SECONDS,
                "posts": await _get_latest_posts(),
                "error": _get_latest_reddit_error(),
            },
        }
    )

    try:
        while True:
            message = await websocket.receive_text()
            if message == "ping":
                await websocket.send_json({"type": "pong"})
                continue
    except WebSocketDisconnect:
        pass
    finally:
        await hub.disconnect(websocket)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("alert_server:app", host="127.0.0.1", port=8000, reload=True)
