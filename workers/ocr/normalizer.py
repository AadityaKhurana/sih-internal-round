# ====================================================================
# LANE C OCR - commented out during lane integration.
# OCR is owned by Lane A (active in main). Lane C's parallel OCR module
# is preserved VERBATIM but inert here, not discarded.
# Restore by uncommenting and reconciling with workers/ocr/detector.py.
# ====================================================================

# import re
#
#
# def normalize_plate(text):
#     if not text:
#         return None
#
#     text = text.upper()
#
#     # Remove spaces, hyphens and punctuation
#     text = re.sub(
#         r"[^A-Z0-9]",
#         "",
#         text,
#     )
#
#     if not text:
#         return None
#
#     return text
