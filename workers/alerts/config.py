import os


DATABASE_URL = os.environ["DATABASE_URL"]
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")

ALERTS_CHANNEL = "alerts:new"

# How often the worker checks PostgreSQL for new sightings.
POLL_INTERVAL_SECONDS = float(
    os.getenv("ALERTS_POLL_INTERVAL_SECONDS", "2")
)

# We repeatedly inspect a small recent window so that late-arriving
# sightings are not easily missed. Deduplication is handled by alerts.dedup_key.
LOOKBACK_MINUTES = int(
    os.getenv("ALERTS_LOOKBACK_MINUTES", "10")
)