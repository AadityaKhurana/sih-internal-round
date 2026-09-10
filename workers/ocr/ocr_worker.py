from recognition import recognize_crops
from plate_sighting_adapter import detection_fields
from anpr_common import PlateSighting


def complete_event(
    event,
    camera_code,
    camera_heading_deg=None,
    night=None
):

    ocr_fields = recognize_crops(

        event.get("crops") or [],

        event.get(
            "crop_quality"
        ) or []

    )


    payload = {

        **detection_fields(

            event,

            camera_code=camera_code,

            camera_heading_deg=
                camera_heading_deg,

            night=night

        ),

        **ocr_fields

    }


    sighting = PlateSighting(
        **payload
    )


    return sighting