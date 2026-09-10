# Shared image for the Lane C workers + demo producer.
# Build context is the repo root so it can install the shared anpr_common package.
FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1

# Shared event contract (anpr_common) + drivers used by the workers.
COPY common /app/common
RUN pip install --no-cache-dir ./common "redis>=5" "psycopg[binary]>=3.2" "pydantic>=2.6"

COPY workers /app/workers
