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


if __name__ == "__main__":
    unittest.main()
