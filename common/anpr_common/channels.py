"""Redis pub/sub channel names — the signal layer between workers and the API's
live publisher. Payload convention: the bare id of the newly-written row (the
authoritative data stays in Postgres; the API loads it and pushes to WebSocket
clients).
"""

ALERTS_CHANNEL = "alerts:new"        # alerts worker publishes alert_id here
SIGHTINGS_CHANNEL = "sightings:new"  # (future) live sightings feed

__all__ = ["ALERTS_CHANNEL", "SIGHTINGS_CHANNEL"]
