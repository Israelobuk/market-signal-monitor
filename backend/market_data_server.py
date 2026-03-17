"""Dedicated market data service for live movers."""

from __future__ import annotations

import os

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from market_data import fetch_market_sets

load_dotenv()

CORS_ALLOW_ORIGINS = [
    origin.strip()
    for origin in os.getenv("CORS_ALLOW_ORIGINS", "http://127.0.0.1:5173,http://localhost:5173").split(",")
    if origin.strip()
]

app = FastAPI(title="Market Signal Monitor Market API")

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
    return {"status": "ok"}


@app.get("/api/market-movers")
async def market_movers() -> dict:
    market_sets = fetch_market_sets()
    return {"results": market_sets.get("popular", []), "sets": market_sets}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("market_data_server:app", host="127.0.0.1", port=8001, reload=True)
