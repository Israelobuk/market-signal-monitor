"""Optional Ollama enrichment for Reddit posts."""

from __future__ import annotations

import json
from collections import deque
from dataclasses import replace
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener

from reddit_scraper import RedditPost


SUPPORTED_SECTORS = {
    "macro",
    "financials",
    "semis-ai",
    "crypto",
    "energy",
    "consumer",
    "healthcare",
    "industrials",
}


class OllamaEnricher:
    """Annotates Reddit posts with local LLM metadata via Ollama."""

    def __init__(
        self,
        base_url: str,
        model: str,
        timeout_seconds: float = 20.0,
        min_confidence: float = 0.55,
        cache_size: int = 2000,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout_seconds = timeout_seconds
        self.min_confidence = min_confidence
        self.http = build_opener(ProxyHandler({}))
        self._cache: dict[str, RedditPost] = {}
        self._cache_order: deque[str] = deque()
        self._cache_size = max(100, cache_size)

    def enrich_posts(self, posts: list[RedditPost]) -> list[RedditPost]:
        if not posts:
            return []

        enriched_posts: list[RedditPost] = []
        ai_filtered_posts: list[RedditPost] = []

        for post in posts:
            enriched = self.enrich_post(post)
            enriched_posts.append(enriched)

            if (
                not enriched.ai_market_relevant
                and enriched.ai_confidence >= self.min_confidence
            ):
                continue

            ai_filtered_posts.append(enriched)

        return ai_filtered_posts or enriched_posts

    def enrich_post(self, post: RedditPost) -> RedditPost:
        cached = self._cache.get(post.post_id)
        if cached is not None:
            return cached

        fallback_post = build_fallback_enrichment(post)
        payload = self._generate_payload(post)
        if payload is None:
            self._remember(fallback_post)
            return fallback_post

        enriched = replace(
            fallback_post,
            ai_summary=self._clean_summary(payload.get("summary")) or fallback_post.ai_summary,
            ai_sector=self._clean_sector(payload.get("sector")) or fallback_post.ai_sector,
            ai_reason=self._clean_reason(payload.get("reason")) or fallback_post.ai_reason,
            ai_confidence=self._clean_confidence(payload.get("confidence")),
            ai_market_relevant=self._clean_market_relevant(payload.get("market_relevant")),
            ai_tickers=self._clean_tickers(payload.get("tickers")) or fallback_post.ai_tickers,
        )
        self._remember(enriched)
        return enriched

    def _remember(self, post: RedditPost) -> None:
        self._cache[post.post_id] = post
        self._cache_order.append(post.post_id)

        while len(self._cache_order) > self._cache_size:
            oldest = self._cache_order.popleft()
            self._cache.pop(oldest, None)

    def _generate_payload(self, post: RedditPost) -> dict[str, Any] | None:
        prompt = self._build_prompt(post)
        request_body = {
            "model": self.model,
            "stream": False,
            "format": "json",
            "options": {
                "temperature": 0.1,
            },
            "prompt": prompt,
        }
        request = Request(
            f"{self.base_url}/api/generate",
            data=json.dumps(request_body).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )

        try:
            with self.http.open(request, timeout=self.timeout_seconds) as response:
                raw = json.loads(response.read().decode("utf-8"))
        except (HTTPError, URLError, TimeoutError, OSError, json.JSONDecodeError):
            return None

        response_text = str(raw.get("response", "")).strip()
        if not response_text:
            return None

        parsed = self._parse_json_object(response_text)
        return parsed if isinstance(parsed, dict) else None

    def chat(
        self,
        messages: list[dict[str, str]],
        system_prompt: str,
    ) -> str | None:
        request_body = {
            "model": self.model,
            "stream": False,
            "messages": [
                {"role": "system", "content": system_prompt},
                *messages,
            ],
            "options": {
                "temperature": 0.2,
            },
        }
        request = Request(
            f"{self.base_url}/api/chat",
            data=json.dumps(request_body).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )

        try:
            with self.http.open(request, timeout=self.timeout_seconds) as response:
                raw = json.loads(response.read().decode("utf-8"))
        except (HTTPError, URLError, TimeoutError, OSError, json.JSONDecodeError):
            return None

        message = raw.get("message", {})
        content = str(message.get("content", "")).strip()
        return content or None

    @staticmethod
    def _parse_json_object(value: str) -> dict[str, Any] | None:
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            start = value.find("{")
            end = value.rfind("}")
            if start == -1 or end == -1 or end <= start:
                return None
            try:
                parsed = json.loads(value[start : end + 1])
                return parsed if isinstance(parsed, dict) else None
            except json.JSONDecodeError:
                return None

    def _build_prompt(self, post: RedditPost) -> str:
        body_excerpt = " ".join((post.body_text or "").split())
        if len(body_excerpt) > 1200:
            body_excerpt = f"{body_excerpt[:1200]}..."

        return (
            "You classify Reddit posts for a live market intelligence dashboard.\n"
            "Decide if the post is actually market-relevant and summarize why it matters.\n"
            "Return only compact JSON with keys:\n"
            'market_relevant (boolean), confidence (0 to 1), sector (one of "macro", '
            '"financials", "semis-ai", "crypto", "energy", "consumer", "healthcare", '
            '"industrials"), tickers (array of uppercase strings), summary (max 220 chars), '
            'reason (max 220 chars).\n'
            "Be conservative. Meme, low-signal, and off-topic posts should be market_relevant=false.\n"
            "For tickers, be stricter than for sector classification:\n"
            "- Only include tickers when the post clearly supports a direct public-market linkage.\n"
            "- Use tickers only if a company/ticker is explicitly mentioned, or the post clearly points to a specific public company that would be directly impacted.\n"
            "- Do not invent broad sector proxy names or default blue chips just because the topic is energy, AI, crypto, macro, or geopolitics.\n"
            "- If the post is mainly macro, policy, commodity, war, or opinion context without a clear company-specific target, return an empty tickers array.\n"
            "- Good: a post about Nvidia demand can justify NVDA. A post about ETF inflows can justify BTC-related proxies only if the post clearly points there.\n"
            "- Bad: a generic oil headline should not automatically become XOM and CVX.\n\n"
            "Write the summary as a short analytical read, not a headline rewrite. Mention the likely market implication.\n"
            "Write the reason as one fuller sentence explaining why traders or investors should care.\n\n"
            f"Title: {post.title}\n"
            f"Subreddit: r/{post.subreddit}\n"
            f"Author: u/{post.username}\n"
            f"Upvotes: {post.score}\n"
            f"Comments: {post.comment_count}\n"
            f"Linked URL: {post.article_link}\n"
            f"Body: {body_excerpt or '[no body text]'}\n"
        )

    @staticmethod
    def _clean_summary(value: Any) -> str:
        text = " ".join(str(value or "").strip().split())
        return text[:220]

    @staticmethod
    def _clean_reason(value: Any) -> str:
        text = " ".join(str(value or "").strip().split())
        return text[:220]

    @staticmethod
    def _clean_confidence(value: Any) -> float:
        try:
            confidence = float(value)
        except (TypeError, ValueError):
            return 0.0
        return max(0.0, min(1.0, confidence))

    @staticmethod
    def _clean_market_relevant(value: Any) -> bool:
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in {"true", "1", "yes"}

    @staticmethod
    def _clean_sector(value: Any) -> str:
        sector = str(value or "").strip().lower()
        return sector if sector in SUPPORTED_SECTORS else ""

    @staticmethod
    def _clean_tickers(value: Any) -> tuple[str, ...]:
        if not isinstance(value, list):
            return ()

        cleaned: list[str] = []
        seen: set[str] = set()
        for item in value:
            ticker = str(item or "").strip().upper()
            if not ticker or len(ticker) > 8 or ticker in seen:
                continue
            if not ticker.replace(".", "").isalnum():
                continue
            seen.add(ticker)
            cleaned.append(ticker)
            if len(cleaned) >= 5:
                break

        return tuple(cleaned)


def enrich_posts_with_fallback(posts: list[RedditPost]) -> list[RedditPost]:
    return [build_fallback_enrichment(post) for post in posts]


def build_fallback_enrichment(post: RedditPost) -> RedditPost:
    sector = _infer_fallback_sector(post)
    summary = _build_fallback_summary(post, sector)
    reason = _build_fallback_reason(post, sector)
    tickers = _extract_tickers_from_text(f"{post.title} {post.body_text}")
    return replace(
        post,
        ai_summary=post.ai_summary or summary,
        ai_sector=post.ai_sector or sector,
        ai_reason=post.ai_reason or reason,
        ai_confidence=max(post.ai_confidence, 0.35),
        ai_market_relevant=post.ai_market_relevant,
        ai_tickers=post.ai_tickers or tickers,
    )


def _infer_fallback_sector(post: RedditPost) -> str:
    haystack = f"{post.title} {post.body_text}".lower()
    if any(term in haystack for term in ("bitcoin", "ethereum", "stablecoin", "crypto", "btc", "eth")):
        return "crypto"
    if any(term in haystack for term in ("oil", "opec", "energy", "gas", "crude", "hormuz")):
        return "energy"
    if any(term in haystack for term in ("chip", "semiconductor", "ai", "data center")):
        return "semis-ai"
    if any(term in haystack for term in ("bank", "treasury", "yield", "credit", "financial")):
        return "financials"
    if any(term in haystack for term in ("consumer", "retail", "spending", "demand")):
        return "consumer"
    if any(term in haystack for term in ("hospital", "drug", "biotech", "healthcare", "medical")):
        return "healthcare"
    if any(term in haystack for term in ("factory", "industrial", "manufacturing", "shipping")):
        return "industrials"
    return "macro"


def _build_fallback_summary(post: RedditPost, sector: str) -> str:
    title = " ".join(post.title.split())
    source = str(post.username or "").strip()
    source_prefix = f"{source} reports " if source else ""
    if len(title) <= 150:
        return f"{source_prefix}{title}, a development to watch for {sector.replace('-', ' ')} exposure.".strip()
    body = _first_sentence(post.body_text)
    if body:
        return f"{title[:120].rstrip()}... {body[:90].rstrip()}".strip()
    return title[:220]


def _build_fallback_reason(post: RedditPost, sector: str) -> str:
    body = _first_sentence(post.body_text)
    if body:
        return (
            f"This matters because {body[0].lower() + body[1:] if len(body) > 1 else body.lower()}, "
            f"which can influence {sector.replace('-', ' ')} positioning and headline-driven trading."
        )[:220]
    title = " ".join(post.title.split())
    return (
        f"This headline points to a potential {sector.replace('-', ' ')} market catalyst, so traders will watch for "
        f"follow-through in related names, sentiment, and macro pricing."
    )[:220]


def _first_sentence(text: str) -> str:
    compact = " ".join(str(text or "").split())
    if not compact:
        return ""
    for separator in ".!?":
        if separator in compact:
            return compact.split(separator, 1)[0].strip()
    return compact[:140].strip()


def _extract_tickers_from_text(text: str) -> tuple[str, ...]:
    import re

    seen: list[str] = []
    for match in re.findall(r"\$([A-Z]{1,5})\b", str(text or "").upper()):
        if match not in seen:
            seen.append(match)
        if len(seen) >= 5:
            break
    return tuple(seen)
