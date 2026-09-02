from fastapi import APIRouter, Depends

from ..security import require_auth
from . import alerts, blacklist, cameras, plates, sightings, trajectory

# Data endpoints (bearer no-op when API_AUTH_TOKEN empty; identity via header).
api_router = APIRouter(dependencies=[Depends(require_auth)])
api_router.include_router(cameras.router)
api_router.include_router(plates.router)
api_router.include_router(trajectory.router)
api_router.include_router(sightings.router)
api_router.include_router(alerts.router)
api_router.include_router(blacklist.router)
# analytics router is added once rewritten to the full contract shape.

__all__ = ["api_router"]
