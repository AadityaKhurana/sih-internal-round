import os


DATABASE_URL = os.environ["DATABASE_URL"]

# How often the worker checks whether a new 5-minute window is ready.
POLL_INTERVAL_SECONDS = int(
    os.getenv("ANALYTICS_POLL_INTERVAL_SECONDS", "10")
)

# How many previous weeks are used to calculate the baseline.
BASELINE_WEEKS = int(
    os.getenv("ANALYTICS_BASELINE_WEEKS", "4")
)

# Significant congestion threshold.
# Example:
#   congestion_score = 1.35
# means travel time is 35% above baseline.
CONGESTION_SIGNIFICANT_RATIO = float(
    os.getenv("ANALYTICS_CONGESTION_THRESHOLD", "1.30")
)

# Significant traffic-volume change.
TRAFFIC_VOLUME_SIGNIFICANT_RATIO = float(
    os.getenv("ANALYTICS_VOLUME_THRESHOLD", "1.50")
)

# Maximum amount of time after entering a link that we will
# consider a sighting at the destination camera to be the same journey.
MAX_JOURNEY_SECONDS = int(
    os.getenv("ANALYTICS_MAX_JOURNEY_SECONDS", "1800")
)