"""Signal detection engine for Market Signal Monitor."""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable

from reddit_scraper import RedditPost


@dataclass(slots=True)
class SignalConfig:
    top_posts_per_cycle: int = 20
    max_processed_posts: int = 10000


class SignalEngine:
    """Emits deduplicated ranked events from 24-hour candidate posts."""

    def __init__(self, config: SignalConfig) -> None:
        self.config = config
        self._processed_post_ids: set[str] = set()
        self._processed_fifo: deque[str] = deque()

    def process_posts(self, posts: Iterable[RedditPost]) -> list[dict]:
        ranked_posts = sorted(
            posts,
            key=lambda post: (post.signal_score, post.created_utc),
            reverse=True,
        )

        events: list[dict] = []
        for post in ranked_posts[: self.config.top_posts_per_cycle]:
            if post.post_id in self._processed_post_ids:
                continue

            self._remember_processed(post.post_id)
            events.append(self._build_event(post))

        return events

    def reset(self) -> None:
        self._processed_post_ids.clear()
        self._processed_fifo.clear()

    def _remember_processed(self, post_id: str) -> None:
        self._processed_post_ids.add(post_id)
        self._processed_fifo.append(post_id)

        while len(self._processed_fifo) > self.config.max_processed_posts:
            oldest = self._processed_fifo.popleft()
            self._processed_post_ids.discard(oldest)

    def _build_event(self, post: RedditPost) -> dict:
        signal_score = round(post.signal_score, 2)

        return {
            "signal_id": f"{post.post_id}-{int(time.time() * 1000)}",
            "event_type": "signal_detected",
            "detected_at": datetime.now(timezone.utc).isoformat(),
            "signal_score": signal_score,
            "reasons": [f"engagement_rank:{signal_score}"],
                "post": {
                    "id": post.post_id,
                    "title": post.title,
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
                    "ai_summary": post.ai_summary,
                    "ai_sector": post.ai_sector,
                    "ai_reason": post.ai_reason,
                    "ai_confidence": round(post.ai_confidence, 3),
                    "ai_market_relevant": post.ai_market_relevant,
                    "ai_tickers": list(post.ai_tickers),
                },
            "metrics": {
                "engagement_score": signal_score,
            },
        }
