import re


def normalize_plate(text):
    if not text:
        return None

    text = text.upper()

    # Remove spaces, hyphens and punctuation
    text = re.sub(
        r"[^A-Z0-9]",
        "",
        text,
    )

    if not text:
        return None

    return text