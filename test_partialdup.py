"""Unit tests for partialdup.py.

    python -m unittest test_partialdup -v

No Stash, no network, no heavy deps required for the Phase-1 tests — they cover
dispatch, the result-encoding contract, and config persistence against a
throwaway SQLite DB (PDC_DB env override). Fingerprint/align/classify tests are
added alongside those features in later phases.
"""

import io
import json
import os
import tempfile
import unittest
from unittest.mock import patch

# Use a throwaway DB so tests never touch the real index.
_TMP_DB = os.path.join(tempfile.gettempdir(), "test_partialdup.sqlite")
os.environ["PDC_DB"] = _TMP_DB

import partialdup  # noqa: E402


def _run_main(input_dict, *, as_stash=True, server_connection=None):
    """Feed a payload to main() and return the decoded {"output", "error"} dict."""
    payload = {"args": input_dict} if as_stash else dict(input_dict)
    if as_stash and server_connection is not None:
        payload["server_connection"] = server_connection
    stdin = io.StringIO(json.dumps(payload))
    stdout = io.StringIO()
    with patch.object(partialdup.sys, "stdin", stdin), \
         patch.object(partialdup.sys, "stdout", stdout):
        try:
            partialdup.main()
        except SystemExit:
            pass
    return json.loads(stdout.getvalue())


class DispatchTests(unittest.TestCase):
    def setUp(self):
        if os.path.exists(_TMP_DB):
            os.remove(_TMP_DB)
        partialdup._SERVER_CONNECTION = None

    def test_check_returns_version(self):
        res = _run_main({"action": "check"})
        self.assertIsNone(res["error"])
        self.assertEqual(res["output"]["version"], partialdup.VERSION)
        self.assertEqual(res["output"]["plugin"], partialdup.PLUGIN_ID)
        self.assertIn("deps", res["output"])
        self.assertIn("requests", res["output"]["deps"])

    def test_missing_action(self):
        res = _run_main({})
        self.assertIsNotNone(res["error"])
        self.assertIn("missing 'action'", res["error"])

    def test_unknown_action(self):
        res = _run_main({"action": "nope"})
        self.assertIsNotNone(res["error"])
        self.assertIn("unknown action", res["error"])

    def test_empty_stdin(self):
        stdout = io.StringIO()
        with patch.object(partialdup.sys, "stdin", io.StringIO("")), \
             patch.object(partialdup.sys, "stdout", stdout):
            try:
                partialdup.main()
            except SystemExit:
                pass
        res = json.loads(stdout.getvalue())
        self.assertEqual(res["error"], "empty stdin")

    def test_scan_requires_server_connection(self):
        partialdup._SERVER_CONNECTION = None
        res = _run_main({"action": "scan"})
        self.assertIsNotNone(res["error"])
        self.assertIn("server_connection", res["error"])

    def test_scan_status_default(self):
        res = _run_main({"action": "scan_status"})
        self.assertIsNone(res["error"])
        self.assertIn("worker_alive", res["output"])

    def test_results_empty(self):
        res = _run_main({"action": "results"})
        self.assertIsNone(res["error"])
        self.assertEqual(res["output"]["total"], 0)
        self.assertEqual(res["output"]["groups"], [])


class ConfigTests(unittest.TestCase):
    def setUp(self):
        if os.path.exists(_TMP_DB):
            os.remove(_TMP_DB)

    def test_get_config_defaults(self):
        res = _run_main({"action": "get_config"})
        self.assertIsNone(res["error"])
        self.assertEqual(res["output"]["mode"], "hybrid")
        self.assertEqual(res["output"]["band_count"], 4)

    def test_set_config_roundtrip(self):
        res = _run_main({"action": "set_config",
                         "config": {"mode": "deep", "deep_interval_s": 1.0}})
        self.assertIsNone(res["error"])
        self.assertEqual(res["output"]["mode"], "deep")
        self.assertEqual(res["output"]["deep_interval_s"], 1.0)
        # Persisted across calls.
        res2 = _run_main({"action": "get_config"})
        self.assertEqual(res2["output"]["mode"], "deep")

    def test_set_config_rejects_unknown_key(self):
        res = _run_main({"action": "set_config", "config": {"bogus": 1}})
        self.assertIsNotNone(res["error"])
        self.assertIn("unknown config keys", res["error"])


class HashTests(unittest.TestCase):
    def test_phash_deterministic(self):
        import numpy as np
        rng = np.random.default_rng(0)
        arr = rng.integers(0, 256, size=(32, 32)).astype("float64")
        h1 = partialdup._phash_from_gray32(arr)
        h2 = partialdup._phash_from_gray32(arr.copy())
        self.assertEqual(h1, h2)
        self.assertTrue(0 <= h1 <= partialdup._MASK64)

    def test_phash_robust_to_small_noise_and_sensitive_to_invert(self):
        import numpy as np
        from PIL import Image
        # A "natural-ish" image with low-frequency content across BOTH axes, so
        # the low-freq DCT coefficients are well-separated from the median and
        # bits are stable (a pure 1-D gradient is degenerate for pHash).
        y, x = np.mgrid[0:64, 0:64].astype("float64")
        base = (128 + 60 * np.sin(2 * np.pi * x / 64) + 50 * np.cos(2 * np.pi * y / 40)
                + 30 * np.sin(2 * np.pi * (x + y) / 50))
        base = np.clip(base, 0, 255).astype("uint8")
        h = partialdup._phash_pil(Image.fromarray(base, "L"))
        rng = np.random.default_rng(1)
        noised = np.clip(base + rng.normal(0, 4, base.shape), 0, 255).astype("uint8")
        hn = partialdup._phash_pil(Image.fromarray(noised, "L"))
        self.assertLessEqual(partialdup._hamming(h, hn), 8)   # robust to noise
        hi = partialdup._phash_pil(Image.fromarray(255 - base, "L"))
        self.assertGreater(partialdup._hamming(h, hi), 25)    # sensitive to invert

    def test_hamming(self):
        self.assertEqual(partialdup._hamming(0b1011, 0b1011), 0)
        self.assertEqual(partialdup._hamming(0b1011, 0b1000), 2)

    def test_bands(self):
        h = 0x123456789ABCDEF0
        bands = partialdup._bands(h, 4)
        self.assertEqual(len(bands), 4)
        self.assertEqual(bands, [0xDEF0, 0x9ABC, 0x5678, 0x1234])  # low → high
        for b in bands:
            self.assertTrue(0 <= b <= 0xFFFF)

    def test_signed_unsigned_roundtrip(self):
        for u in (0, 1, (1 << 63), (1 << 63) + 5, partialdup._MASK64):
            self.assertEqual(partialdup._s2u(partialdup._u2s(u)), u)
            self.assertTrue(-(1 << 63) <= partialdup._u2s(u) < (1 << 63))


class VttTests(unittest.TestCase):
    SAMPLE = (
        "WEBVTT\n\n"
        "00:00:00.000 --> 00:00:30.000\n"
        "abc_sprite.jpg#xywh=0,0,160,90\n\n"
        "00:00:30.000 --> 00:01:00.000\n"
        "abc_sprite.jpg#xywh=160,0,160,90\n\n"
        "00:01:00.000 --> 00:01:30.000\n"
        "abc_sprite.jpg#xywh=320,0,160,90\n"
    )

    def test_parse_vtt(self):
        cues = partialdup._parse_vtt(self.SAMPLE)
        self.assertEqual(len(cues), 3)
        self.assertEqual(cues[0], (0.0, (0, 0, 160, 90)))
        self.assertEqual(cues[1], (30.0, (160, 0, 160, 90)))
        self.assertEqual(cues[2][0], 60.0)

    def test_vtt_ts(self):
        self.assertEqual(partialdup._vtt_ts("00:01:30.000"), 90.0)
        self.assertEqual(partialdup._vtt_ts("02:05.500"), 125.5)


def _find_ffmpeg():
    ff, _ = partialdup._ffmpeg_paths({"ffmpeg_path": os.environ.get("PDC_FFMPEG", "")})
    return ff


@unittest.skipUnless(_find_ffmpeg(), "ffmpeg not available")
class FfmpegTimelineTests(unittest.TestCase):
    def test_deep_timeline_on_synthetic_video(self):
        import subprocess
        ff = _find_ffmpeg()
        vid = os.path.join(tempfile.gettempdir(), "pdc_testsrc.mp4")
        # 10s deterministic test pattern, 30fps.
        subprocess.run(
            [ff, "-y", "-v", "error", "-f", "lavfi", "-i",
             "testsrc=size=320x240:rate=30:duration=10", "-pix_fmt", "yuv420p", vid],
            check=True,
        )
        try:
            tl = partialdup._ffmpeg_timeline(vid, 1.0, ff)
            self.assertGreaterEqual(len(tl), 8)        # ~10 frames @ 1/s
            self.assertEqual(tl[0][0], 0.0)
            for _, h in tl:
                self.assertTrue(0 <= h <= partialdup._MASK64)
            # Re-running is byte-stable → identical hashes.
            tl2 = partialdup._ffmpeg_timeline(vid, 1.0, ff)
            self.assertEqual([h for _, h in tl], [h for _, h in tl2])
        finally:
            if os.path.exists(vid):
                os.remove(vid)


if __name__ == "__main__":
    unittest.main()
