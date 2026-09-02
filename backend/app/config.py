from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Config is entirely URL/env driven so local vs. managed (Supabase/Upstash/
    any S3) is a .env change, not a code change."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: str = "local"

    # Shared bearer token gating the data endpoints. Empty = auth disabled (dev).
    api_auth_token: str = ""

    database_url: str = "postgresql://anpr:anpr@postgres:5432/anpr"
    redis_url: str = "redis://redis:6379/0"

    s3_endpoint_url: str = "http://minio:9000"
    s3_access_key: str = "minioadmin"
    s3_secret_key: str = "minioadmin"
    s3_bucket: str = "anpr-media"
    s3_region: str = "us-east-1"


settings = Settings()
