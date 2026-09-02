# ====================================================================
# LANE C OCR - commented out during lane integration.
# OCR is owned by Lane A (active in main). Lane C's parallel OCR module
# is preserved VERBATIM but inert here, not discarded.
# Restore by uncommenting and reconciling with workers/ocr/detector.py.
# ====================================================================

# from collections import defaultdict
#
#
# class PlateVoter:
#     def __init__(self, min_votes=3):
#         self.min_votes = min_votes
#
#         self.readings = defaultdict(list)
#
#     def add(
#         self,
#         track_id,
#         plate,
#         confidence,
#     ):
#         if not plate:
#             return None
#
#         self.readings[track_id].append(
#             {
#                 "plate": plate,
#                 "confidence": confidence,
#             }
#         )
#
#         return self.get_best(track_id)
#
#     def get_best(self, track_id):
#         readings = self.readings.get(
#             track_id,
#             [],
#         )
#
#         if len(readings) < self.min_votes:
#             return None
#
#         scores = defaultdict(float)
#         counts = defaultdict(int)
#
#         for reading in readings:
#             plate = reading["plate"]
#             confidence = reading["confidence"]
#
#             scores[plate] += confidence
#             counts[plate] += 1
#
#         candidates = list(scores.keys())
#
#         best = max(
#             candidates,
#             key=lambda plate: (
#                 counts[plate],
#                 scores[plate],
#             ),
#         )
#
#         return {
#             "plate": best,
#             "confidence": (
#                 scores[best] / counts[best]
#             ),
#             "votes": counts[best],
#             "candidates": [
#                 {
#                     "plate": plate,
#                     "confidence": (
#                         scores[plate]
#                         / counts[plate]
#                     ),
#                 }
#                 for plate in candidates
#             ],
#         }
#
#     def clear(self, track_id):
#         self.readings.pop(
#             track_id,
#             None,
#         )
