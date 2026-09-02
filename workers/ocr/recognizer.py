# ====================================================================
# LANE C OCR - commented out during lane integration.
# OCR is owned by Lane A (active in main). Lane C's parallel OCR module
# is preserved VERBATIM but inert here, not discarded.
# Restore by uncommenting and reconciling with workers/ocr/detector.py.
# ====================================================================

# from paddleocr import PaddleOCR
#
# from .config import OCR_CONFIDENCE
#
#
# class PlateRecognizer:
#     def __init__(self):
#         self.ocr = PaddleOCR(
#             lang="en",
#             use_doc_orientation_classify=False,
#             use_doc_unwarping=False,
#             use_textline_orientation=False,
#         )
#
#     def recognize(self, crop):
#         if crop is None or crop.size == 0:
#             return None
#
#         result = self.ocr.predict(crop)
#
#         best_text = None
#         best_confidence = 0.0
#
#         for page in result:
#             data = page
#
#             texts = data.get("rec_texts", [])
#             scores = data.get("rec_scores", [])
#
#             for text, score in zip(texts, scores):
#                 score = float(score)
#
#                 if score >= OCR_CONFIDENCE:
#                     if score > best_confidence:
#                         best_text = text
#                         best_confidence = score
#
#         if best_text is None:
#             return None
#
#         return {
#             "text": best_text,
#             "confidence": best_confidence,
#         }
