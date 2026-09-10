"""Audit logging for sensitive actions (alert acknowledgements, trajectory /
owner / evidence views). Best-effort: a logging failure must not break the
request, so callers may wrap this defensively.

NOTE(auth): `user_subject` is currently supplied by the caller (no auth yet).
Once authentication lands, derive it from the authenticated principal instead.
"""
from __future__ import annotations

from typing import Any

from psycopg.types.json import Jsonb

from .db import fetch_one

_INSERT = """
    INSERT INTO audit_logs (user_subject, action, target_type, target_id, purpose, metadata)
    VALUES (%(user_subject)s, %(action)s, %(target_type)s, %(target_id)s, %(purpose)s, %(metadata)s)
    RETURNING audit_id::text AS audit_id
"""


async def record_audit(
    user_subject: str,
    action: str,
    *,
    target_type: str | None = None,
    target_id: str | None = None,
    purpose: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> str | None:
    row = await fetch_one(
        _INSERT,
        {
            "user_subject": user_subject,
            "action": action,
            "target_type": target_type,
            "target_id": target_id,
            "purpose": purpose,
            "metadata": Jsonb(metadata or {}),
        },
    )
    return row["audit_id"] if row else None
