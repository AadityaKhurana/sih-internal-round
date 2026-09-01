#!/usr/bin/env python3
"""
Stage 1 -- video ingest.

Owns everything before detection: opening the source, keeping frames fresh,
surviving disconnections, and stamping each frame with a capture time.

    from ingest import CameraStream

    for frame, ts, fid in CameraStream("rtsp://...").frames():
        events = detector.process_frame(frame, ts)

Self-test:
    python ingest.py --source clip.mp4 --max-frames 60
"""
import argparse
import queue
import threading
import time
from pathlib import Path

import cv2

LIVE_SCHEMES = ("rtsp://", "rtsps://", "http://", "https://", "rtmp://", "udp://")

RECONNECT_BACKOFF_START = 1.0
RECONNECT_BACKOFF_MAX = 30.0
OPEN_TIMEOUT_MS = 8000


def is_live_source(source):
    """
    Live vs file. This distinction drives BOTH the reconnect policy and the
    buffering policy, and getting it wrong breaks each in a different way:

      - Treat a live stream as a file  -> it shuts down on the first dropped
        packet and never reconnects.
      - Treat a file as a live stream  -> drop-to-latest discards ~97% of
        frames (the reader runs at ~100fps, the detector at ~3), tracking
        collapses because ByteTrack needs consecutive frames, and no two runs
        produce the same result.
    """
    s = str(source)
    return s.isdigit() or s.lower().startswith(LIVE_SCHEMES)


class CameraStream:
    """
    One camera. Reads on a background thread; the main thread consumes.

    Live sources  -> drop-to-latest. The reader overwrites a single slot, so
                     the consumer always gets the newest frame and latency
                     stays constant no matter how slow inference is. Without
                     this, OpenCV's internal buffer makes you fall further
                     behind every second, unboundedly.

    File sources  -> bounded blocking queue. Every frame is delivered in
                     order, and the reader blocks when the consumer lags.
                     Deterministic, which is what benchmarking needs.
    """

    def __init__(self, source, camera_id="CAM01", queue_size=8,
                 max_open_attempts=0):
        self.source = source
        self.camera_id = camera_id
        self.live = is_live_source(source)
        self.max_open_attempts = max_open_attempts   # 0 = retry forever

        self.cap = None
        self.stopped = False
        self._lock = threading.Lock()
        self._latest = None                       # live mode
        self._q = queue.Queue(maxsize=queue_size)  # file mode
        self._thread = None

        self.fps = 0.0
        self.width = self.height = 0
        self.total_frames = 0
        self.stats = {"frames_read": 0, "frames_dropped": 0,
                      "reconnects": 0, "open_failures": 0}

        self._open()

    # ------------------------------------------------------------------ #

    def _open(self):
        """
        Open the source, retrying with exponential backoff.

        Bounded by max_open_attempts so a typo'd URL raises instead of hanging
        the process silently forever.
        """
        backoff = RECONNECT_BACKOFF_START
        attempt = 0
        while not self.stopped:
            attempt += 1
            cap = cv2.VideoCapture(str(self.source))
            try:
                cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, OPEN_TIMEOUT_MS)
                cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, OPEN_TIMEOUT_MS)
            except Exception:
                pass  # not supported on every backend; harmless

            if cap.isOpened():
                self.cap = cap
                self.fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
                self.width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
                self.height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
                self.total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
                print(f"[{self.camera_id}] connected "
                      f"{self.width}x{self.height} @ {self.fps:.1f}fps "
                      f"({'live' if self.live else 'file'})")
                return

            cap.release()
            self.stats["open_failures"] += 1
            if self.max_open_attempts and attempt >= self.max_open_attempts:
                raise ConnectionError(
                    f"[{self.camera_id}] could not open {self.source} "
                    f"after {attempt} attempts")
            print(f"[{self.camera_id}] open failed, retry in {backoff:.0f}s "
                  f"(attempt {attempt})")
            time.sleep(backoff)
            backoff = min(backoff * 2, RECONNECT_BACKOFF_MAX)

    # ------------------------------------------------------------------ #

    def _reader(self):
        fid = 0
        backoff = RECONNECT_BACKOFF_START
        while not self.stopped:
            if self.cap is None or not self.cap.isOpened():
                self.stats["reconnects"] += 1
                self._open()
                continue

            ok, frame = self.cap.read()

            if not ok:
                if not self.live:
                    self.stopped = True          # genuine end of file
                    break
                # live stream hiccup: tear down and reconnect. This is the
                # branch the original code could never reach, because an
                # rtsp:// URL is a non-numeric string and was classed as a file.
                print(f"[{self.camera_id}] stream dropped, reconnecting")
                self.cap.release()
                self.cap = None
                self.stats["reconnects"] += 1
                time.sleep(backoff)
                backoff = min(backoff * 2, RECONNECT_BACKOFF_MAX)
                continue

            backoff = RECONNECT_BACKOFF_START
            fid += 1
            self.stats["frames_read"] += 1
            item = (frame, time.time(), fid)

            if self.live:
                with self._lock:
                    if self._latest is not None:
                        self.stats["frames_dropped"] += 1
                    self._latest = item
            else:
                while not self.stopped:
                    try:
                        self._q.put(item, timeout=0.5)
                        break
                    except queue.Full:
                        continue

        # unblock any waiting consumer
        if not self.live:
            try:
                self._q.put_nowait(None)
            except queue.Full:
                pass

    # ------------------------------------------------------------------ #

    def frames(self):
        """
        Yield (frame_bgr, capture_ts, frame_id) until the source ends.

        capture_ts is a unix float taken at read time. Pass it straight to
        detector.process_frame() -- transit-time calculations between cameras
        depend on it, and a frame index cannot substitute.
        """
        self._thread = threading.Thread(target=self._reader, daemon=True)
        self._thread.start()

        try:
            while True:
                if self.live:
                    with self._lock:
                        item, self._latest = self._latest, None
                    if item is None:
                        if self.stopped:
                            break
                        time.sleep(0.005)
                        continue
                    yield item
                else:
                    try:
                        item = self._q.get(timeout=1.0)
                    except queue.Empty:
                        if self.stopped:
                            break
                        continue
                    if item is None:
                        break
                    yield item
        finally:
            self.release()

    def metadata(self):
        return {"camera_id": self.camera_id, "source": str(self.source),
                "live": self.live, "fps": round(self.fps, 2),
                "width": self.width, "height": self.height,
                "total_frames": self.total_frames, "stats": dict(self.stats)}

    def release(self):
        self.stopped = True
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        if self.cap:
            self.cap.release()
            self.cap = None


# ---------------------------------------------------------------------- #

def load_camera_config(path):
    """
    camera_config.json -- one entry per camera.

    install_bearing_deg matters: the detector reports direction in IMAGE space
    (0 = up the frame). Adding this gives a compass bearing, which is what the
    backend needs to tell inbound from outbound.
    """
    import json
    with open(path, encoding="utf-8") as fh:
        cfg = json.load(fh)
    return cfg if isinstance(cfg, list) else [cfg]


EXAMPLE_CONFIG = [{
    "camera_id": "CAM_MG_ROAD_01",
    "source": "rtsp://user:pass@192.168.1.50:554/stream1",
    "lat": 22.5726,
    "lng": 88.3639,
    "install_bearing_deg": 47,
    "roi_polygon": [[0, 400], [1920, 380], [1920, 1080], [0, 1080]]
}]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, help="file path or rtsp:// url")
    ap.add_argument("--camera-id", default="CAM01")
    ap.add_argument("--max-frames", type=int, default=60)
    ap.add_argument("--write-example-config", default=None)
    args = ap.parse_args()

    if args.write_example_config:
        import json
        with open(args.write_example_config, "w", encoding="utf-8") as fh:
            json.dump(EXAMPLE_CONFIG, fh, indent=2)
        print(f"wrote {args.write_example_config}")
        return

    st = CameraStream(args.source, camera_id=args.camera_id)
    print("metadata:", st.metadata())

    t0 = time.time()
    n = 0
    first_ts = last_ts = None
    for frame, ts, fid in st.frames():
        n += 1
        if first_ts is None:
            first_ts = ts
        last_ts = ts
        if n >= args.max_frames:
            break
    el = time.time() - t0

    print(f"\n  delivered {n} frames in {el:.1f}s  ({n/el:.1f} fps)")
    print(f"  capture span {last_ts - first_ts:.2f}s" if first_ts else "")
    print(f"  stats: {st.stats}")
    if not st.live:
        assert st.stats["frames_dropped"] == 0, \
            "file source dropped frames -- tracking would break"
        print("  file mode: 0 frames dropped, order preserved (correct)")


if __name__ == "__main__":
    main()
