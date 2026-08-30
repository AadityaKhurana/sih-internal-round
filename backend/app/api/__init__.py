from fastapi import APIRouter, Depends

from ..security import require_auth
from . import alerts, analytics, cameras, trajectory

# Every data endpoint requires a valid bearer token (when auth is enabled).
# /health and / are defined on the app directly and stay open for liveness.
api_router = APIRouter(dependencies=[Depends(require_auth)])
api_router.include_router(cameras.router)
api_router.include_router(trajectory.router)
api_router.include_router(alerts.router)
api_router.include_router(analytics.router)

__all__ = ["api_router"]
