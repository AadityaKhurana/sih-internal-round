from __future__ import annotations

from collections import defaultdict
from pathlib import Path
import copy
import os
import re
import sys

import cv2
import numpy as np


# ============================================================
# Paths
# ============================================================

ROOT = Path(__file__).resolve().parent

MODEL_PATH = ROOT / "models" / "model.safetensors"
DICT_PATH = ROOT / "models" / "en_dict.txt"


# ============================================================
# PaddleOCR source
# ============================================================

def find_paddleocr():

    candidates = [
        ROOT / "PaddleOCR",
        ROOT / "models" / "PaddleOCR",
        Path.home() / "PaddleOCR",
    ]

    for path in candidates:

        if (
            path.exists()
            and (path / "ppocr").exists()
        ):
            return path

    return None


PADDLEOCR_DIR = find_paddleocr()

if PADDLEOCR_DIR is not None:

    path_string = str(
        PADDLEOCR_DIR
    )

    if path_string not in sys.path:

        sys.path.insert(
            0,
            path_string
        )


# ============================================================
# IMPORTANT:
# Use the Awiros model architecture directly.
# This avoids running test.py as a subprocess.
# ============================================================

import paddle


from safetensors.numpy import load_file


from ppocr.modeling.architectures import (
    build_model
)


from ppocr.postprocess import (
    build_post_process
)


# ============================================================
# Awiros model configuration
#
# This matches the released PP-OCRv5 ANPR model.
# ============================================================

MODEL_CONFIG = {

    "Architecture": {

        "model_type": "rec",

        "algorithm": "SVTR_HGNet",

        "Transform": None,

        "Backbone": {

            "name": "PPHGNetV2_B4"

        },

        "Head": {

            "name": "MultiHead",

            "head_list": [

                {
                    "CTCHead": {

                        "Neck": {

                            "name": "svtr",

                            "dims": 120,

                            "depth": 2,

                            "hidden_dims": 120,

                            "kernel_size": [1, 3],

                            "use_guide": True

                        },

                        "Head": {

                            "fc_decay": 1e-5

                        }

                    }

                },

                {

                    "NRTRHead": {

                        "nrtr_dim": 384,

                        "max_text_length": 25

                    }

                }

            ]

        }

    }

}


IMAGE_SHAPE = (
    3,
    48,
    320
)


# ============================================================
# OCR engine
# ============================================================

class AwirosANPROCR:

    def __init__(
        self,
        model_path: Path = MODEL_PATH,
        dict_path: Path = DICT_PATH,
        device: str = "cpu"
    ):

        self.model_path = Path(
            model_path
        )

        self.dict_path = Path(
            dict_path
        )

        if not self.model_path.exists():

            raise FileNotFoundError(
                f"Awiros model not found:\n"
                f"{self.model_path}"
            )

        if not self.dict_path.exists():

            raise FileNotFoundError(
                f"Awiros dictionary not found:\n"
                f"{self.dict_path}"
            )


        # ----------------------------------------------------
        # Device
        # ----------------------------------------------------

        if (
            device == "gpu"
            and paddle.is_compiled_with_cuda()
        ):

            paddle.set_device(
                "gpu"
            )

        else:

            paddle.set_device(
                "cpu"
            )


        # ----------------------------------------------------
        # Postprocessor
        # ----------------------------------------------------

        self.post_process = build_post_process({

            "name":
                "CTCLabelDecode",

            "character_dict_path":
                str(self.dict_path),

            "use_space_char":
                True

        })


        # ----------------------------------------------------
        # Model
        # ----------------------------------------------------

        config = copy.deepcopy(
            MODEL_CONFIG
        )

        self.model = build_model(
            config["Architecture"]
        )

        self.model.eval()


        # ----------------------------------------------------
        # Load SafeTensors
        # ----------------------------------------------------

        state_dict_np = load_file(
            str(self.model_path)
        )

        state_dict = {

            key:
                paddle.to_tensor(value)

            for key, value
            in state_dict_np.items()

        }

        self.model.set_state_dict(
            state_dict
        )


        print(
            f"[OCR] Awiros model loaded: "
            f"{self.model_path}"
        )


    # ========================================================
    # Preprocessing
    # ========================================================

    @staticmethod
    def preprocess(
        image_bgr
    ):

        if image_bgr is None:

            raise ValueError(
                "Image is None"
            )

        h, w = image_bgr.shape[:2]

        if h <= 0 or w <= 0:

            raise ValueError(
                "Invalid image dimensions"
            )


        target_h = 48
        target_w = 320


        ratio = (
            target_h
            / float(h)
        )


        new_w = min(
            int(
                w * ratio
            ),
            target_w
        )


        resized = cv2.resize(

            image_bgr,

            (
                new_w,
                target_h
            ),

            interpolation=cv2.INTER_CUBIC

        )


        # Right padding
        if new_w < target_w:

            padded = np.zeros(

                (
                    target_h,
                    target_w,
                    3
                ),

                dtype=np.uint8

            )

            padded[
                :,
                :new_w,
                :
            ] = resized

            resized = padded


        else:

            resized = resized[
                :,
                :target_w,
                :
            ]


        image = (
            resized
            .astype(np.float32)
            / 255.0
        )


        image = (
            image - 0.5
        ) / 0.5


        image = image.transpose(
            (2, 0, 1)
        )


        return image


    # ========================================================
    # One crop
    # ========================================================

    def recognize_one(
        self,
        image_bgr
    ):

        tensor = self.preprocess(
            image_bgr
        )


        tensor = np.expand_dims(
            tensor,
            axis=0
        )


        tensor = paddle.to_tensor(
            tensor
        )


        with paddle.no_grad():

            prediction = self.model(
                tensor
            )


        if isinstance(
            prediction,
            dict
        ):

            prediction = prediction.get(
                "ctc",
                next(
                    iter(
                        prediction.values()
                    )
                )
            )

        elif isinstance(
            prediction,
            (list, tuple)
        ):

            prediction = prediction[0]


        result = self.post_process(
            prediction
        )


        if not result:

            return None, 0.0


        text = None
        confidence = 0.0


        try:

            text = result[0][0]

            confidence = float(
                result[0][1]
            )

        except (
            IndexError,
            TypeError,
            KeyError
        ):

            return None, 0.0


        text = normalize_plate(
            text
        )


        if not text:

            return None, 0.0


        return (
            text,
            max(
                0.0,
                min(
                    1.0,
                    confidence
                )
            )
        )


# ============================================================
# GLOBAL OCR ENGINE
# ============================================================

OCR_ENGINE = None


def get_ocr():

    global OCR_ENGINE

    if OCR_ENGINE is None:

        OCR_ENGINE = AwirosANPROCR()

    return OCR_ENGINE


# ============================================================
# Normalization
# ============================================================

def normalize_plate(
    text: str | None
) -> str | None:

    if not text:

        return None


    text = str(
        text
    ).upper()


    text = re.sub(
        r"[^A-Z0-9]",
        "",
        text
    )


    return text or None


# ============================================================
# Five-crop recognition + weighted voting
# ============================================================

def recognize_crops(
    crops,
    crop_quality=None
):

    """
    Input:
        crops:
            up to 5 OpenCV BGR images

        crop_quality:
            corresponding quality scores

    Output:
        EXACTLY the four OCR fields required by PlateSighting.
    """

    # --------------------------------------------------------
    # No crop at all
    # --------------------------------------------------------

    if not crops:

        return {

            "raw_plate_text":
                "NO_PLATE",

            "normalized_plate":
                None,

            "ocr_confidence":
                0.0,

            "ocr_candidates":
                []

        }


    if crop_quality is None:

        crop_quality = [
            1.0
            for _ in crops
        ]


    engine = get_ocr()


    predictions = []


    # --------------------------------------------------------
    # OCR every available crop
    # --------------------------------------------------------

    for index, crop in enumerate(crops):

        if crop is None:
            continue

        if crop.size == 0:
            continue


        try:

            text, confidence = (
                engine.recognize_one(
                    crop
                )
            )

        except Exception as exc:

            print(
                f"[OCR] crop {index} failed: "
                f"{exc}"
            )

            continue


        if not text:
            continue


        quality = (

            float(
                crop_quality[index]
            )

            if index < len(
                crop_quality
            )

            else 1.0

        )


        # Quality is a voting weight,
        # not plate-ness.

        weight = (

            confidence

            * max(
                quality,
                0.01
            )

        )


        predictions.append({

            "plate":
                text,

            "confidence":
                confidence,

            "quality":
                quality,

            "weight":
                weight

        })


    # --------------------------------------------------------
    # All OCR failed
    # --------------------------------------------------------

    if not predictions:

        return {

            "raw_plate_text":
                "UNREAD",

            "normalized_plate":
                None,

            "ocr_confidence":
                0.0,

            "ocr_candidates":
                []

        }


    # --------------------------------------------------------
    # Group same OCR outputs
    # --------------------------------------------------------

    groups = defaultdict(
        lambda: {

            "weight":
                0.0,

            "confidences":
                []

        }
    )


    for prediction in predictions:

        plate = prediction[
            "plate"
        ]


        groups[plate][
            "weight"
        ] += prediction[
            "weight"
        ]


        groups[plate][
            "confidences"
        ].append(
            prediction[
                "confidence"
            ]
        )


    # --------------------------------------------------------
    # Winner
    # --------------------------------------------------------

    winner = max(

        groups,

        key=lambda plate:
            groups[plate]["weight"]

    )


    winner_confidences = (
        groups[winner][
            "confidences"
        ]
    )


    voted_confidence = (

        sum(
            winner_confidences
        )
        /
        len(
            winner_confidences
        )

    )


    # --------------------------------------------------------
    # Contract candidates
    # --------------------------------------------------------

    from anpr_common import (
        OcrCandidate
    )


    candidate_models = []


    for plate, data in sorted(

        groups.items(),

        key=lambda item:
            item[1]["weight"],

        reverse=True

    ):


        avg_confidence = (

            sum(
                data[
                    "confidences"
                ]
            )
            /
            len(
                data[
                    "confidences"
                ]
            )

        )


        candidate_models.append(

            OcrCandidate(

                plate=plate,

                confidence=max(

                    0.0,

                    min(
                        1.0,
                        avg_confidence
                    )

                )

            )

        )


    # --------------------------------------------------------
    # Final OCR fields
    # --------------------------------------------------------

    return {

        "raw_plate_text":
            winner,

        "normalized_plate":
            winner,

        "ocr_confidence":
            round(
                max(
                    0.0,
                    min(
                        1.0,
                        voted_confidence
                    )
                ),
                4
            ),

        "ocr_candidates":
            candidate_models

    }