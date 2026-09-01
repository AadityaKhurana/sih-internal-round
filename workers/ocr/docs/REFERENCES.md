# References and Licensing

## Models

- **Ultralytics YOLO11 / YOLO26 / ByteTrack** — AGPL-3.0.
  https://github.com/ultralytics/ultralytics
- **morsetechlab, *YOLOv11 License Plate Detection*** — AGPL-3.0.
  https://huggingface.co/morsetechlab/yolov11-license-plate-detection
  *Model card notes train/test contamination in the upstream Roboflow dataset;
  its reported metrics are inflated and were not used.*

**Production note:** both are AGPL-3.0. Deployment requires an Ultralytics
Enterprise licence or an MIT/Apache detector behind the same interface.

## Datasets

- **RodoSol-ALPR** — R. Laroca, E. V. Cardoso, D. R. Lucio, V. Estevam,
  D. Menotti, "On the Cross-Dataset Generalization in License Plate
  Recognition," *VISAPP*, pp. 166–178, Feb 2022.
- **UFPR-ALPR** — R. Laroca, E. Severo, L. A. Zanlorensi, L. S. Oliveira,
  G. R. Gonçalves, W. R. Schwartz, D. Menotti, "A Robust Real-Time Automatic
  License Plate Recognition Based on the YOLO Detector," *IJCNN*, pp. 1–10,
  July 2018.
- **UA-DETRAC** — L. Wen et al., "UA-DETRAC: A New Benchmark and Protocol for
  Multi-Object Detection and Tracking," *CVIU*, 2020.

**RodoSol-ALPR and UFPR-ALPR are licensed for non-commercial academic use
only. Images may not be redistributed and are not included in this
repository.** Aggregate metrics only; use own footage for visuals unless
written permission is obtained.

## Methodology

- R. Laroca et al., "Do We Train on Test Data? The Impact of Near-Duplicates
  on License Plate Recognition," *IJCNN*, 2023. — *why we discarded the plate
  model's published metrics and measured our own.*
- *ICPR 2026 Competition on Low-Resolution License Plate Recognition* —
  five-image-per-track aggregation; SOTA 50–60 % on low-resolution plates.

## Standards

- Central Motor Vehicles Rules (CMVR), Rule 50 — Indian plate dimensions.
  340×200 mm (MCV/HCV), 500×120 mm (LMV), 200×100 mm (two-wheeler rear),
  285×45 mm (two-wheeler front). Letters `O` and `I` are avoided to prevent
  confusion with `0` and `1`.
