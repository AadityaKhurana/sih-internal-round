"""Shared-secret bearer-token auth for the API.

Prototype-grade: one token (API_AUTH_TOKEN) gates the data endpoints. When the
token is unset, auth is DISABLED (allow all) — convenient for local dev/tests,
with a startup warning logged. Real per-user identity (JWT/OAuth) is future work.
"""
from __future__ import annotations

from fastapi import Header, HTTPException, WebSocket, status

from .config import settings


def _extract_bearer(authorization: str | None) -> str | None:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return None


async def require_auth(authorization: str | None = Header(default=None)) -> None:
    """FastAPI dependency: reject requests without a valid bearer token."""
    if not settings.api_auth_token:
        return  # auth disabled
    if _extract_bearer(authorization) != settings.api_auth_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )


async def authorize_ws(websocket: WebSocket, token: str | None) -> bool:
    """WebSocket auth via ?token= (browsers can't set headers on a WS handshake).
    Closes with policy-violation (1008) on a bad token."""
    if not settings.api_auth_token:
        return True
    if token == settings.api_auth_token:
        return True
    await websocket.close(code=1008)
    return False
