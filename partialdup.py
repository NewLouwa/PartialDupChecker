#!/usr/bin/env python3
"""PartialDupChecker — Stash plugin backend.

Detects PARTIAL video duplicates that Stash's built-in (whole-file phash)
duplicate finder misses, in three levels:

    DUPLICATE      same content end-to-end (re-encode / recrop / rewatermark)
    PART/CONTAINS  one video is a contiguous chunk of a longer one
    CUT/MONTAGE    partial, reordered, or spliced overlap (compilation)

It is a SEPARATE plugin that COMPLEMENTS the native tool — it never replaces it
and never mutates the library unless the user explicitly asks (opt-in `apply`).

Approach: build a per-scene perceptual-hash *timeline* (segment pHashes), index
the segments with LSH bands for candidate retrieval at scale, align candidate
pairs to localize matched time-ranges, and classify by coverage/contiguity/order.

--- Stash plugin contract (interface: raw) -------------------------------------
Stash invokes `python partialdup.py` and writes a JSON payload on stdin:

    {"args": {"action": "...", ...}, "server_connection": {...}}

We dispatch on args["action"] and print {"output": <result>, "error": <msg>} to
stdout, always exiting 0 so failures surface through runPluginOperation's
GraphQL error channel rather than crashing the Stash job. (Same contract the
MEGA Import plugin uses.)

Heavy deps (numpy, Pillow) are imported lazily inside the functions that need
them, so the module always loads — `check` and dispatch work even before those
deps are installed (e.g. on a fresh box, or when only running smoke tests).
"""

import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time

# Vendor-aware import: if a bundled _vendor/ dir sits next to this file, add it as
# a FALLBACK (append, not prepend) so the system/installed packages always win and
# _vendor is used only when a dep is otherwise missing. This is essential because
# _vendor ships platform-specific binaries (numpy/Pillow musllinux wheels for the
# Alpine prod container) — prepending would shadow the local install and crash on
# a different platform (e.g. Windows). Appending lets the same folder work on both:
# local uses its installed numpy/Pillow; Alpine prod falls through to _vendor.
_VENDOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_vendor")
if os.path.isdir(_VENDOR) and _VENDOR not in sys.path:
    sys.path.append(_VENDOR)

VERSION = "0.1.0"
PLUGIN_ID = "partial_dup_checker"
LOG_PREFIX = "[partialdup]"

# Module-level server connection (scheme/port/session cookie), captured in main()
# so the detached worker can call back into Stash.
_SERVER_CONNECTION = None


# --------------------------------------------------------------------------- #
# Result encoding + logging
# --------------------------------------------------------------------------- #
def _log(msg):
    """Write a line to stderr (line-buffered) — shows up in Stash's plugin log."""
    print(f"{LOG_PREFIX} {msg}", file=sys.stderr, flush=True)


def _write(result, error):
    """Emit {"output": result, "error": error} and exit 0.

    Errors are encoded in the payload (not via a non-zero exit) so Stash routes
    them through runPluginOperation's GraphQL error instead of failing the job.
    """
    sys.stdout.write(json.dumps({"output": result, "error": error}))
    sys.stdout.flush()
    sys.exit(0)


class PdcError(Exception):
    """A handled, user-facing error (returned as {"error": ...})."""


# --------------------------------------------------------------------------- #
# GraphQL bridge to Stash  (copied pattern from MEGA Import _gql)
# --------------------------------------------------------------------------- #
def _gql(server_connection, query, variables=None):
    """POST a GraphQL query/mutation to the local Stash using the session cookie.

    Returns the parsed JSON ({"data": ..., "errors": ...}).
    """
    import requests

    sc = server_connection or {}
    scheme = (sc.get("Scheme") or "http").lower()
    port = sc.get("Port") or 9999
    url = f"{scheme}://localhost:{port}/graphql"
    cookies = {}
    sk = sc.get("SessionCookie") or {}
    if sk.get("Name"):
        cookies[sk["Name"]] = sk.get("Value", "")
    r = requests.post(
        url,
        json={"query": query, "variables": variables or {}},
        cookies=cookies,
        timeout=120,
    )
    return r.json()


def _gql_data(server_connection, query, variables=None):
    """_gql but raise PdcError on GraphQL errors and return the `data` dict."""
    resp = _gql(server_connection, query, variables)
    if not isinstance(resp, dict):
        raise PdcError(f"GraphQL: unexpected response: {resp!r}")
    if resp.get("errors"):
        msgs = "; ".join(e.get("message", str(e)) for e in resp["errors"])
        raise PdcError(f"GraphQL error: {msgs}")
    return resp.get("data") or {}


def _stash_base_url(server_connection):
    """Base http(s)://localhost:port for fetching generated assets (sprites/vtt)."""
    sc = server_connection or {}
    scheme = (sc.get("Scheme") or "http").lower()
    port = sc.get("Port") or 9999
    return f"{scheme}://localhost:{port}"


def _stash_cookies(server_connection):
    sc = server_connection or {}
    sk = sc.get("SessionCookie") or {}
    return {sk["Name"]: sk.get("Value", "")} if sk.get("Name") else {}


# --------------------------------------------------------------------------- #
# SQLite index / state
# --------------------------------------------------------------------------- #
_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT
);
-- One row per fingerprinted scene.
CREATE TABLE IF NOT EXISTS scenes (
    scene_id    INTEGER PRIMARY KEY,
    file_hash   TEXT,        -- oshash/phash of primary file (skip re-index if unchanged)
    title       TEXT,
    path        TEXT,
    duration    REAL,
    n_segments  INTEGER,
    mode        TEXT,        -- 'fast' (sprite) | 'deep' (ffmpeg)
    indexed_at  REAL
);
-- Ordered pHash timeline: one row per sampled segment.
CREATE TABLE IF NOT EXISTS segments (
    scene_id    INTEGER,
    idx         INTEGER,     -- position in the scene's timeline
    t_seconds   REAL,        -- timestamp of the sample
    phash       INTEGER,     -- 64-bit DCT perceptual hash
    PRIMARY KEY (scene_id, idx)
);
-- LSH band index for candidate retrieval (split each 64-bit phash into bands).
CREATE TABLE IF NOT EXISTS hash_bands (
    band_no     INTEGER,
    band_val    INTEGER,
    scene_id    INTEGER,
    idx         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_band ON hash_bands (band_no, band_val);
CREATE INDEX IF NOT EXISTS idx_band_scene ON hash_bands (scene_id);
-- Detected relationships (one group = one match between two scenes).
CREATE TABLE IF NOT EXISTS groups (
    group_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    level       TEXT,        -- 'DUPLICATE' | 'PART' | 'CUT'
    scene_a     INTEGER,     -- longer / containing scene
    scene_b     INTEGER,     -- shorter / contained scene
    confidence  REAL,
    coverage_a  REAL,
    coverage_b  REAL,
    runs_json   TEXT,        -- matched time-ranges
    applied     INTEGER DEFAULT 0,
    created_at  REAL
);
"""

# Tunable detection config; persisted in meta and overridable via set_config.
DEFAULT_CONFIG = {
    "mode": "hybrid",            # 'fast' | 'deep' | 'hybrid'
    "deep_interval_s": 2.0,      # ffmpeg deep-pass sampling cadence (seconds)
    "segment_hamming": 8,        # max per-segment Hamming distance for a match
    "band_count": 4,             # LSH bands (64 bits / 4 = 16-bit bands)
    "min_candidate_segs": 4,     # scene pair shortlisted if it shares >= this many segments
    "min_run_segs": 2,           # ignore matched runs shorter than this (noise)
    "gap_tol": 1,                # tolerate this many missing seeds inside a run
    "max_bucket": 200,           # skip non-discriminative band buckets (blank/common frames)
    "top_k_candidates": 30,      # per-scene fanout cap (bounds the candidate set at scale)
    "max_candidate_pairs": 200000,  # hard cap on total candidate pairs (logged if hit)
    "max_deep_scenes": 300,      # hybrid: max distinct scenes to deep-fingerprint (ffmpeg budget)
    "max_deep_pairs": 3000,      # hybrid: max cross-space pairs to deep-confirm
    "max_deep_seconds": 900,     # hybrid: wall-clock cap on deep-confirm (guarantees the scan finishes)
    "dup_min_coverage": 0.95,    # DUPLICATE: coverage both ways
    "part_min_coverage": 0.90,   # PART: longest contiguous run as a fraction of the shorter
    "cut_min_coverage": 0.55,    # CUT/MONTAGE: total coverage of the shorter clip
    "ffmpeg_path": "",           # override; else PDC_FFMPEG env / PATH
    "ffprobe_path": "",          # override; else PDC_FFPROBE env / PATH
}


def _db_path():
    return os.environ.get("PDC_DB") or os.path.join(
        tempfile.gettempdir(), ".partialdup.sqlite"
    )


def _connect():
    conn = sqlite3.connect(_db_path(), timeout=30)
    conn.row_factory = sqlite3.Row
    # WAL + busy_timeout: the detached worker writes for the whole scan while the
    # request process reads/writes status & results on its own connection. WAL lets
    # readers proceed during writes; busy_timeout makes every connection wait out a
    # lock instead of immediately raising "database is locked".
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=30000")
        conn.execute("PRAGMA synchronous=NORMAL")
    except sqlite3.Error:
        pass
    conn.executescript(_SCHEMA)
    return conn


def _meta_get(conn, key, default=None):
    row = conn.execute("SELECT v FROM meta WHERE k=?", (key,)).fetchone()
    if row is None:
        return default
    try:
        return json.loads(row["v"])
    except (json.JSONDecodeError, TypeError):
        return row["v"]


def _meta_set(conn, key, value):
    conn.execute(
        "INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)",
        (key, json.dumps(value)),
    )
    conn.commit()


def _get_config(conn):
    """Merge persisted overrides over DEFAULT_CONFIG."""
    cfg = dict(DEFAULT_CONFIG)
    saved = _meta_get(conn, "config", {})
    if isinstance(saved, dict):
        cfg.update(saved)
    return cfg


# --------------------------------------------------------------------------- #
# Detached worker (survives UI/tab close)  — pattern from MEGA Import
# --------------------------------------------------------------------------- #
def _pid_alive(pid):
    if not pid:
        return False
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    try:
        if sys.platform.startswith("win"):
            import ctypes
            from ctypes import wintypes

            k = ctypes.windll.kernel32
            # A Win64 HANDLE is 64-bit; without explicit restype/argtypes ctypes
            # marshals it through a 32-bit int and can corrupt the handle (wrong
            # liveness, leaked handle). Pin the signatures.
            k.OpenProcess.restype = wintypes.HANDLE
            k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            k.GetExitCodeProcess.restype = wintypes.BOOL
            k.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
            k.CloseHandle.argtypes = [wintypes.HANDLE]
            h = k.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
            if not h:
                return False
            try:
                code = wintypes.DWORD()
                ok = k.GetExitCodeProcess(h, ctypes.byref(code))
            finally:
                k.CloseHandle(h)
            if not ok:
                return True  # query failed → assume alive (avoid spawning a 2nd worker)
            return code.value == 259  # STILL_ACTIVE
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def _spawn_worker(server_connection):
    """Spawn a detached background process running the scan pipeline.

    Stash kills request-bound plugin subprocesses on client disconnect, so the
    long-running scan must run in a process detached from the request.
    """
    import subprocess

    payload = json.dumps(
        {"action": "__worker", "server_connection": server_connection or {}}
    ).encode("utf-8")
    logf = open(_db_path() + ".worker.log", "ab")
    kwargs = {
        "stdin": subprocess.PIPE,
        "stdout": logf,
        "stderr": logf,
        "close_fds": True,
    }
    if sys.platform.startswith("win"):
        # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        kwargs["creationflags"] = 0x00000008 | 0x00000200
    else:
        kwargs["start_new_session"] = True
    proc = subprocess.Popen([sys.executable, os.path.abspath(__file__)], **kwargs)
    try:
        proc.stdin.write(payload)
        proc.stdin.close()
    except Exception:
        pass
    return proc.pid


# --------------------------------------------------------------------------- #
# Scan status helpers
# --------------------------------------------------------------------------- #
def _set_status(conn, **fields):
    st = _meta_get(conn, "scan_status", {}) or {}
    st.update(fields)
    st["updated_at"] = time.time()
    _meta_set(conn, "scan_status", st)
    return st


def _ffmpeg_paths(cfg=None):
    """Locate ffmpeg/ffprobe: config override → env override → PATH."""
    cfg = cfg or {}
    ffmpeg = (cfg.get("ffmpeg_path") or os.environ.get("PDC_FFMPEG")
              or shutil.which("ffmpeg"))
    ffprobe = (cfg.get("ffprobe_path") or os.environ.get("PDC_FFPROBE")
               or shutil.which("ffprobe"))
    return ffmpeg, ffprobe


def _dep_available(name):
    try:
        __import__(name)
        return True
    except Exception:
        return False


# --------------------------------------------------------------------------- #
# Perceptual hashing (64-bit DCT pHash) + LSH bands
# --------------------------------------------------------------------------- #
_MASK64 = (1 << 64) - 1
_DCT32 = None  # cached 32x32 DCT-II basis matrix (numpy)


def _dct_matrix(n):
    """DCT-II basis matrix D[k,i] = cos(pi*(2i+1)*k / 2n). 2-D DCT = D @ img @ D.T.

    The per-axis scale factors are omitted: pHash thresholds each coefficient
    against the *median*, so any global scaling leaves the resulting bits
    unchanged. This matches imagehash's phash bits without needing scipy.
    """
    import numpy as np

    i = np.arange(n)
    k = i.reshape(-1, 1)
    return np.cos(np.pi * (2 * i + 1) * k / (2 * n)).astype("float64")


def _phash_from_gray32(arr):
    """pHash a 32x32 grayscale float array → unsigned 64-bit int."""
    import numpy as np

    global _DCT32
    if _DCT32 is None:
        _DCT32 = _dct_matrix(32)
    d = _DCT32 @ arr.astype("float64") @ _DCT32.T
    low = d[:8, :8]
    med = np.median(low)
    bits = (low > med).flatten()
    h = 0
    for b in bits:
        h = (h << 1) | int(b)
    return h


def _phash_pil(img):
    """pHash a PIL image (any size/mode) → unsigned 64-bit int."""
    import numpy as np

    g = img.convert("L").resize((32, 32))
    return _phash_from_gray32(np.asarray(g, dtype="float64"))


def _hamming(a, b):
    """Hamming distance between two unsigned ints (0..64 for pHashes)."""
    return (a ^ b).bit_count()


def _bands(phash, band_count):
    """Split a 64-bit hash into band_count equal sub-words (LSH buckets)."""
    width = 64 // band_count
    mask = (1 << width) - 1
    return [(phash >> (b * width)) & mask for b in range(band_count)]


def _u2s(u):
    """Map an unsigned 64-bit int to signed for SQLite storage (it rejects >=2^63)."""
    return u - (1 << 64) if u >= (1 << 63) else u


def _s2u(s):
    return s & _MASK64


# --------------------------------------------------------------------------- #
# Fingerprint extraction: sprite fast-pass + ffmpeg deep-pass
# --------------------------------------------------------------------------- #
def _vtt_ts(s):
    """Parse a WebVTT timestamp 'HH:MM:SS.mmm' or 'MM:SS.mmm' → seconds."""
    s = s.strip()
    parts = s.split(":")
    try:
        if len(parts) == 3:
            h, m, sec = parts
            return int(h) * 3600 + int(m) * 60 + float(sec)
        if len(parts) == 2:
            m, sec = parts
            return int(m) * 60 + float(sec)
        return float(s)
    except ValueError:
        return 0.0


def _parse_vtt(text):
    """Parse a Stash sprite VTT → ordered list of (t_start_seconds, (x, y, w, h))."""
    import re

    out = []
    for block in re.split(r"\n\s*\n", text.strip()):
        lines = block.strip().splitlines()
        t_line = xywh = None
        for ln in lines:
            if "-->" in ln:
                t_line = ln
            m = re.search(r"#xywh=(\d+),(\d+),(\d+),(\d+)", ln)
            if m:
                xywh = tuple(int(x) for x in m.groups())
        if t_line and xywh:
            start = t_line.split("-->")[0].strip()
            out.append((_vtt_ts(start), xywh))
    out.sort(key=lambda r: r[0])
    return out


def _http_get(url, server_connection, *, binary=False, timeout=60):
    import requests

    r = requests.get(url, cookies=_stash_cookies(server_connection), timeout=timeout)
    r.raise_for_status()
    return r.content if binary else r.text


def _sprite_timeline(scene, server_connection):
    """Fast pass: fetch the scene's sprite sheet + VTT, crop each cell, pHash it.

    Returns an ordered [(t_seconds, phash)] timeline (≈30 s spacing — coarse, good
    for whole-video DUPLICATE and rough PART; short cuts need the deep pass).
    """
    from io import BytesIO
    from PIL import Image

    if not scene.get("sprite_url") or not scene.get("vtt_url"):
        raise PdcError("scene has no sprite/vtt (not generated)")
    cues = _parse_vtt(_http_get(scene["vtt_url"], server_connection))
    if not cues:
        raise PdcError("empty/unparseable VTT")
    sheet = Image.open(BytesIO(_http_get(scene["sprite_url"], server_connection, binary=True)))
    sheet.load()
    timeline = []
    for t, (x, y, w, h) in cues:
        cell = sheet.crop((x, y, x + w, y + h))
        timeline.append((t, _phash_pil(cell)))
    return timeline


def _ffmpeg_timeline(path, interval_s, ffmpeg):
    """Deep pass: sample 1 frame / interval_s, scaled to 32x32 gray, via a raw
    pipe (no temp files, no Pillow) → ordered [(t_seconds, phash)] timeline."""
    import subprocess

    import numpy as np

    if not ffmpeg:
        raise PdcError("ffmpeg not found (set ffmpeg_path or PDC_FFMPEG)")
    if not path or not os.path.exists(path):
        raise PdcError(f"file not found: {path}")
    interval_s = max(0.2, float(interval_s))
    cmd = [
        ffmpeg, "-v", "error", "-i", path,
        "-vf", f"fps=1/{interval_s},scale=32:32,format=gray",
        "-f", "rawvideo", "pipe:1",
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise PdcError(f"ffmpeg failed: {proc.stderr.decode('utf-8', 'replace')[:200]}")
    data = proc.stdout
    frame = 32 * 32
    timeline = []
    for idx in range(len(data) // frame):
        chunk = data[idx * frame:(idx + 1) * frame]
        arr = np.frombuffer(chunk, dtype=np.uint8).reshape(32, 32)
        timeline.append((idx * interval_s, _phash_from_gray32(arr)))
    return timeline


def _file_hash(scene):
    return (scene.get("oshash") or scene.get("phash")
            or f"{scene.get('path')}:{scene.get('duration')}")


def _index_scene(conn, scene, pass_kind, cfg, server_connection, ffmpeg):
    """Fingerprint one scene and (re)write its segment + band rows.

    pass_kind: 'fast' (sprite) or 'deep' (ffmpeg). Returns segment count.
    Skips work if the file hash + pass already match what's indexed.
    """
    sid = scene["id"]
    # Index signature = file identity + pass + (for deep) the sampling interval.
    # The interval MUST be part of it: the diagonal alignment assumes a uniform
    # cadence, so two scenes indexed at different intervals can't be matched.
    # Re-index whenever any of these change.
    fh = _file_hash(scene)
    sig = f"{fh}|deep|{cfg['deep_interval_s']}" if pass_kind == "deep" else f"{fh}|fast"
    row = conn.execute(
        "SELECT file_hash, n_segments, mode FROM scenes WHERE scene_id=?", (sid,)
    ).fetchone()
    if row and row["file_hash"] == sig and (row["n_segments"] or 0) > 0 \
            and row["mode"] == pass_kind:
        return row["n_segments"]

    if pass_kind == "deep":
        timeline = _ffmpeg_timeline(scene["path"], cfg["deep_interval_s"], ffmpeg)
    else:
        timeline = _sprite_timeline(scene, server_connection)

    band_count = cfg["band_count"]
    seg_rows, band_rows = [], []
    for idx, (t, h) in enumerate(timeline):
        seg_rows.append((sid, idx, t, _u2s(h)))
        for b, bv in enumerate(_bands(h, band_count)):
            band_rows.append((b, _u2s(bv), sid, idx))  # signed: bands may be 64-bit wide

    # Atomic: DELETE both child tables + re-INSERT + upsert the scenes row all
    # commit together (or roll back together on failure) so a mid-write error
    # can't leave a stale n_segments with truncated segment/band rows.
    with conn:
        conn.execute("DELETE FROM segments WHERE scene_id=?", (sid,))
        conn.execute("DELETE FROM hash_bands WHERE scene_id=?", (sid,))
        conn.executemany("INSERT OR REPLACE INTO segments VALUES (?,?,?,?)", seg_rows)
        conn.executemany("INSERT INTO hash_bands VALUES (?,?,?,?)", band_rows)
        conn.execute(
            "INSERT OR REPLACE INTO scenes "
            "(scene_id, file_hash, title, path, duration, n_segments, mode, indexed_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (sid, sig, scene["title"], scene["path"], scene["duration"],
             len(timeline), pass_kind, time.time()),
        )
    return len(timeline)


# --------------------------------------------------------------------------- #
# Matching: candidate retrieval → alignment → 3-level classification
# --------------------------------------------------------------------------- #
def _candidate_pairs(seg_by_scene, cfg):
    """Shortlist scene pairs that share enough band-matching segments.

    Uses an LSH band bucket map: segments landing in the same (band_no, band_val)
    bucket are near-duplicates. Over-popular buckets (blank/black frames) are
    skipped as non-discriminative. Recall need only surface the *pair* — exact
    matched segments are recovered later by direct-Hamming alignment.
    """
    from collections import defaultdict

    band_count = cfg["band_count"]
    max_bucket = cfg["max_bucket"]
    buckets = defaultdict(list)
    for sid, segs in seg_by_scene.items():
        for idx, _t, h in segs:
            for b, bv in enumerate(_bands(h, band_count)):
                buckets[(b, bv)].append((sid, idx))

    pair_hits = defaultdict(set)  # (lo, hi) -> set of lo-side seg idxs that matched
    for members in buckets.values():
        if len(members) > max_bucket or len(members) < 2:
            continue
        for a in range(len(members)):
            sa, ia = members[a]
            for c in range(a + 1, len(members)):
                sc, ic = members[c]
                if sa == sc:
                    continue
                if sa < sc:
                    pair_hits[(sa, sc)].add(ia)
                else:
                    pair_hits[(sc, sa)].add(ic)
    floor = cfg["min_candidate_segs"]
    score = {p: len(h) for p, h in pair_hits.items() if len(h) >= floor}
    if not score:
        return []

    # Bound the candidate set at scale (a large/repetitive library can otherwise
    # produce hundreds of thousands of weak coincidental pairs). Keep, per scene,
    # only its top-K partners by shared-segment count — real duplicates share many
    # segments and survive; weak 1-bucket coincidences are dropped.
    k = cfg["top_k_candidates"]
    by_scene = defaultdict(list)
    for (lo, hi), n in score.items():
        by_scene[lo].append(((lo, hi), n))
        by_scene[hi].append(((lo, hi), n))
    keep = set()
    for lst in by_scene.values():
        lst.sort(key=lambda x: -x[1])
        for pair, _n in lst[:k]:
            keep.add(pair)

    pairs = sorted(keep, key=lambda p: -score[p])  # strongest first
    cap = cfg["max_candidate_pairs"]
    if len(pairs) > cap:
        _log(f"candidate pairs capped at {cap} (from {len(pairs)}) — raise "
             f"max_candidate_pairs or min_candidate_segs to widen/narrow")
        pairs = pairs[:cap]
    return pairs


def _align_hashes(A, B, cfg):
    """Diagonal seed-and-extend alignment of two ordered pHash sequences.

    A contiguous copy shows up as a run of seed matches along a constant
    diagonal (i - j == offset); reordered/spliced montage pieces appear as
    separate runs on different diagonals. Returns (runs, avg_hamming) where each
    run = {a0, a1, b0, b1, segs} (inclusive segment-index ranges into A and B).
    """
    from collections import defaultdict

    max_h = cfg["segment_hamming"]
    band_count = cfg["band_count"]
    gap_tol = cfg["gap_tol"]

    # Seed via B's band buckets, then verify with direct Hamming.
    bbuckets = defaultdict(list)
    for j, h in enumerate(B):
        for b, bv in enumerate(_bands(h, band_count)):
            bbuckets[(b, bv)].append(j)

    seeds = []
    ham_sum = 0
    for i, h in enumerate(A):
        seen_j = set()
        for b, bv in enumerate(_bands(h, band_count)):
            for j in bbuckets.get((b, bv), ()):
                if j in seen_j:
                    continue
                seen_j.add(j)
                d = _hamming(h, B[j])
                if d <= max_h:
                    seeds.append((i, j, d))
    if not seeds:
        return [], 0.0

    # Group seeds by diagonal, then split each diagonal into runs at gaps.
    by_diag = defaultdict(list)
    for i, j, d in seeds:
        by_diag[i - j].append((i, j, d))
    runs = []
    for pts in by_diag.values():
        pts.sort()
        s = 0
        for k in range(1, len(pts) + 1):
            if k == len(pts) or pts[k][0] - pts[k - 1][0] > gap_tol + 1:
                seg = pts[s:k]
                ham = [p[2] for p in seg]
                runs.append({
                    "a0": seg[0][0], "a1": seg[-1][0],
                    "b0": seg[0][1], "b1": seg[-1][1],
                    "segs": len(seg),
                    "avg_h": sum(ham) / len(ham),
                })
                ham_sum += sum(ham)
                s = k
    total_seeds = sum(r["segs"] for r in runs)
    avg_hamming = ham_sum / total_seeds if total_seeds else 0.0
    return runs, avg_hamming


def _select_runs(runs, min_run):
    """Greedy non-overlapping decomposition: longest (lowest-Hamming) runs first,
    each claiming a B-segment interval no later run may reuse.

    Repetitive/near-static content spawns many overlapping seed runs; attributing
    each B segment to a single best run yields a clean, minimal set of matched
    regions (and a meaningful run count) instead of dozens of overlapping ones.
    """
    sig = sorted((r for r in runs if r["segs"] >= min_run),
                 key=lambda r: (-(r["b1"] - r["b0"] + 1), r["avg_h"]))
    claimed, selected = [], []
    for r in sig:
        b0, b1 = r["b0"], r["b1"]
        if any(not (b1 < c0 or b0 > c1) for c0, c1 in claimed):
            continue  # B interval overlaps an already-claimed match
        claimed.append((b0, b1))
        selected.append(r)
    selected.sort(key=lambda r: r["b0"])
    return selected


def _metrics(runs, len_a, len_b, cfg):
    """Coverage / contiguity / ordering metrics from a clean run decomposition."""
    # Clamp the min-run filter so a very short scene (e.g. a single-segment
    # timeline) is still analyzable instead of having its only run discarded.
    min_run = max(1, min(cfg["min_run_segs"], len_b))
    sel = _select_runs(runs, min_run)
    covered_a, cb_segs = set(), 0
    for r in sel:
        covered_a.update(range(r["a0"], r["a1"] + 1))
        cb_segs += r["b1"] - r["b0"] + 1  # selected runs are non-overlapping in B
    longest_b = max((r["b1"] - r["b0"] + 1 for r in sel), default=0)
    order_ok, prev = True, None  # runs sorted by b0; A starts should be monotonic
    for r in sel:
        if prev is not None and r["a0"] < prev:
            order_ok = False
            break
        prev = r["a0"]
    return {
        "coverage_a": len(covered_a) / len_a if len_a else 0.0,
        "coverage_b": min(1.0, cb_segs / len_b) if len_b else 0.0,
        "frac_longest_b": longest_b / len_b if len_b else 0.0,
        "n_sig_runs": len(sel),
        "order_preserved": order_ok,
        "sig_runs": sel,
    }


def _classify(m, cfg):
    """Map metrics → (level, confidence). A is the longer/containing scene."""
    cb, ca = m["coverage_b"], m["coverage_a"]
    if cb >= cfg["dup_min_coverage"] and ca >= cfg["dup_min_coverage"]:
        return "DUPLICATE", round(min(ca, cb), 3)
    if m["frac_longest_b"] >= cfg["part_min_coverage"]:
        # The shorter scene is (almost) one contiguous chunk of the longer one.
        return "PART", round(m["frac_longest_b"], 3)
    if cb >= cfg["cut_min_coverage"] and m["n_sig_runs"] >= 1:
        # Partial / reordered / spliced overlap — a cut or montage.
        return "CUT", round(cb, 3)
    return None, 0.0


def _match_pair(segs_x, segs_y, cfg):
    """Align two scenes' segment timelines and classify. Returns a dict or None.

    Picks the longer timeline as A (the containing scene).
    """
    if len(segs_x) >= len(segs_y):
        a_segs, b_segs, swap = segs_x, segs_y, False
    else:
        a_segs, b_segs, swap = segs_y, segs_x, True
    A = [h for _i, _t, h in a_segs]
    B = [h for _i, _t, h in b_segs]
    runs, avg_h = _align_hashes(A, B, cfg)
    if not runs:
        return None
    m = _metrics(runs, len(A), len(B), cfg)
    level, conf = _classify(m, cfg)
    if not level:
        return None
    # Attach time-ranges (a_* on the longer scene, b_* on the shorter).
    ta = [t for _i, t, _h in a_segs]
    tb = [t for _i, t, _h in b_segs]
    ranges = [{
        "a_start": round(ta[r["a0"]], 2), "a_end": round(ta[r["a1"]], 2),
        "b_start": round(tb[r["b0"]], 2), "b_end": round(tb[r["b1"]], 2),
        "segs": r["segs"],
    } for r in m["sig_runs"]]
    ranges.sort(key=lambda r: r["b_start"])
    return {
        "level": level, "confidence": conf,
        "coverage_a": round(m["coverage_a"], 3),
        "coverage_b": round(m["coverage_b"], 3),
        "avg_hamming": round(avg_h, 2),
        "ranges": ranges, "swap": swap,
    }


def _load_segments(conn):
    """Load all indexed segments grouped by scene → {sid: [(idx, t, unsigned_hash)]}."""
    seg_by_scene = {}
    rows = conn.execute(
        "SELECT scene_id, idx, t_seconds, phash FROM segments ORDER BY scene_id, idx"
    ).fetchall()
    for r in rows:
        seg_by_scene.setdefault(r["scene_id"], []).append(
            (r["idx"], r["t_seconds"], _s2u(r["phash"]))
        )
    return seg_by_scene


def _deep_segments(conn, sid, cfg, ffmpeg, cache):
    """Deep-fingerprint a scene on demand (cached), for hybrid confirm. Falls
    back to None if it can't (caller then keeps the fast timeline)."""
    if sid in cache:
        return cache[sid]
    row = conn.execute("SELECT path FROM scenes WHERE scene_id=?", (sid,)).fetchone()
    try:
        tl = _ffmpeg_timeline(row["path"], cfg["deep_interval_s"], ffmpeg) if row else []
        segs = [(i, t, h) for i, (t, h) in enumerate(tl)]
    except Exception as e:
        _log(f"deep-confirm scene {sid} failed: {e}")
        segs = None
    cache[sid] = segs
    return segs


def _persist_group(conn, lo, hi, res):
    scene_a, scene_b = (hi, lo) if res["swap"] else (lo, hi)
    conn.execute(
        "INSERT INTO groups (level, scene_a, scene_b, confidence, coverage_a, "
        "coverage_b, runs_json, applied, created_at) VALUES (?,?,?,?,?,?,?,0,?)",
        (res["level"], scene_a, scene_b, res["confidence"], res["coverage_a"],
         res["coverage_b"], json.dumps(res["ranges"]), time.time()),
    )


def _match_and_classify(conn, cfg, server_connection=None, ffmpeg=None):
    """Find candidate pairs, align + classify, persist groups. Returns count.

    Scales to large libraries by NOT deep-decoding speculatively:
      1. Shortlist candidate pairs (bounded — see _candidate_pairs).
      2. Fast-classify every same-space pair on the (cheap, in-memory) index
         timelines — no ffmpeg.
      3. Hybrid only: deep-fingerprint just the *hits* (and a bounded set of
         cross-space candidates) to refine ranges / reject sprite coincidences.
    The old code deep-confirmed every candidate pair up front, which was O(pairs)
    ffmpeg decodes — infeasible at thousands of scenes.
    """
    fast_segs = _load_segments(conn)
    conn.execute("DELETE FROM groups")
    conn.commit()
    if len(fast_segs) < 2:
        return 0

    pairs = _candidate_pairs(fast_segs, cfg)
    hybrid = cfg.get("mode") == "hybrid" and bool(ffmpeg)
    # Hash space per scene ('fast' sprite vs 'deep' ffmpeg) — not directly
    # comparable, so same-space pairs are fast-classified; cross-space pairs are
    # only resolvable by deep-confirm (hybrid).
    modes = {r["scene_id"]: r["mode"]
             for r in conn.execute("SELECT scene_id, mode FROM scenes")}
    total = len(pairs)
    _set_status(conn, phase="matching", pairs_total=total, pairs_done=0)
    _log(f"matching: {len(fast_segs)} scenes, {total} candidate pairs")

    # Pass 1 — fast-classify (no ffmpeg).
    hits = []   # [(lo, hi, fast_result)]
    cross = []  # cross-space pairs deferred to deep-confirm (hybrid)
    for i, (lo, hi) in enumerate(pairs):
        if modes.get(lo) != modes.get(hi):
            if hybrid:
                cross.append((lo, hi))
            continue
        res = _match_pair(fast_segs[lo], fast_segs[hi], cfg)
        if res:
            hits.append((lo, hi, res))
        if (i + 1) % 2000 == 0:
            _set_status(conn, pairs_done=i + 1)
    _set_status(conn, pairs_done=total)
    _log(f"fast-classify: {len(hits)} hits, {len(cross)} cross-space deferred")

    results = {(lo, hi): res for lo, hi, res in hits}  # default to fast result

    # Pass 2 — hybrid deep-confirm (bounded ffmpeg). Refine hits to precise
    # ranges and drop sprite-only coincidences; resolve a capped set of
    # cross-space candidates.
    if hybrid:
        _set_status(conn, phase="confirming")
        deep_cache = {}
        max_deep = cfg["max_deep_scenes"]
        budget_s = cfg["max_deep_seconds"]
        t0 = time.time()
        # Strongest hits first so the (bounded) ffmpeg budget refines the most
        # confident matches; cross-space candidates after, capped.
        ordered = [(lo, hi) for lo, hi, _ in
                   sorted(hits, key=lambda x: -x[2]["confidence"])]
        dropped = max(0, len(cross) - cfg["max_deep_pairs"])
        todo = ordered + cross[: cfg["max_deep_pairs"]]
        confirmed = 0
        stopped = None
        for lo, hi in todo:
            if time.time() - t0 > budget_s:   # wall-clock cap → guarantees finishing
                stopped = "time-budget"
                break
            # ffmpeg scene budget: skip pairs needing a not-yet-decoded scene
            # once the distinct-scene cap is reached (keep the fast result).
            if (len(deep_cache) >= max_deep
                    and lo not in deep_cache and hi not in deep_cache):
                stopped = "scene-budget"
                continue
            dlo = _deep_segments(conn, lo, cfg, ffmpeg, deep_cache)
            dhi = _deep_segments(conn, hi, cfg, ffmpeg, deep_cache)
            if dlo and dhi:
                r = _match_pair(dlo, dhi, cfg)
                if r:
                    results[(lo, hi)] = r
                else:
                    results.pop((lo, hi), None)  # deep ran, no match → drop
            confirmed += 1
            if confirmed % 10 == 0:
                _set_status(conn, confirmed=confirmed, deep_scenes=len(deep_cache))
        if stopped or dropped:
            _log(f"deep-confirm bounded: confirmed={confirmed}, "
                 f"deep_scenes={len(deep_cache)}, stopped={stopped}, "
                 f"cross_dropped={dropped} (rest keep fast/sprite classification)")

    for (lo, hi), res in results.items():
        _persist_group(conn, lo, hi, res)
    conn.commit()
    _log(f"matching: {len(results)} groups")
    return len(results)


# --------------------------------------------------------------------------- #
# Actions
# --------------------------------------------------------------------------- #
def action_check(args):
    """Health/version check + environment report (smoke-test target)."""
    conn = _connect()
    try:
        cfg = _get_config(conn)
    finally:
        conn.close()
    ffmpeg, ffprobe = _ffmpeg_paths(cfg)
    return {
        "version": VERSION,
        "plugin": PLUGIN_ID,
        "python": sys.version.split()[0],
        "platform": sys.platform,
        "db": _db_path(),
        "deps": {
            "requests": _dep_available("requests"),
            "numpy": _dep_available("numpy"),
            "PIL": _dep_available("PIL"),
        },
        "ffmpeg": ffmpeg,
        "ffprobe": ffprobe,
    }


def action_get_config(args):
    conn = _connect()
    try:
        return _get_config(conn)
    finally:
        conn.close()


def action_set_config(args):
    """Persist config overrides. Accepts a subset of DEFAULT_CONFIG keys."""
    updates = args.get("config") or {}
    if not isinstance(updates, dict):
        raise PdcError("config must be an object")
    unknown = set(updates) - set(DEFAULT_CONFIG)
    if unknown:
        raise PdcError(f"unknown config keys: {sorted(unknown)}")
    bc = updates.get("band_count")
    if bc is not None and (not isinstance(bc, int) or bc < 2 or bc > 32 or 64 % bc != 0):
        raise PdcError("band_count must be an integer that divides 64 and is >= 2 "
                       "(e.g. 2, 4, 8, 16, 32)")
    if "mode" in updates and updates["mode"] not in ("fast", "deep", "hybrid"):
        raise PdcError("mode must be 'fast', 'deep', or 'hybrid'")
    conn = _connect()
    try:
        saved = _meta_get(conn, "config", {}) or {}
        saved.update(updates)
        _meta_set(conn, "config", saved)
        return _get_config(conn)
    finally:
        conn.close()


def action_scan_status(args):
    conn = _connect()
    try:
        st = _meta_get(conn, "scan_status", {}) or {}
        st["worker_alive"] = _pid_alive(st.get("worker_pid"))
        return st
    finally:
        conn.close()


def action_scan(args):
    """Start a (detached) library scan. Returns immediately with the worker pid.

    Phase 1: enumerate scenes + record counts. Fingerprint/match land in later
    phases via the _worker_loop pipeline.
    """
    conn = _connect()
    try:
        st = _meta_get(conn, "scan_status", {}) or {}
        if st.get("running") and _pid_alive(st.get("worker_pid")):
            return {"started": False, "reason": "already running", "status": st}
        if not _SERVER_CONNECTION:
            raise PdcError("no server_connection (run inside Stash)")
        _set_status(
            conn, running=True, phase="starting", scenes_done=0, scenes_total=0,
            groups=0, error=None, started_at=time.time(), worker_pid=None,
        )
    finally:
        conn.close()

    try:
        pid = _spawn_worker(_SERVER_CONNECTION)
    except Exception as e:
        # Don't leave status stuck at running=True with no worker.
        conn = _connect()
        try:
            _set_status(conn, running=False, phase="error", error=f"spawn failed: {e}")
        finally:
            conn.close()
        raise PdcError(f"failed to start worker: {e}")

    # Worker_pid is set here (same value the worker writes) so the double-start
    # guard works immediately, before the worker's first status write.
    conn = _connect()
    try:
        _set_status(conn, worker_pid=pid)
    finally:
        conn.close()
    return {"started": True, "worker_pid": pid}


def action_reset(args):
    """Force-clear a stuck scan status. Escape hatch for the rare case where a
    worker was killed abnormally and its PID was later reused (so the liveness
    check wrongly reports it alive and blocks new scans)."""
    conn = _connect()
    try:
        _set_status(conn, running=False, phase="reset", worker_pid=None, error=None)
        return {"reset": True}
    finally:
        conn.close()


def action_results(args):
    """Return detected groups, optionally filtered by level, paginated."""
    level = args.get("level")  # 'DUPLICATE' | 'PART' | 'CUT' | None
    limit = int(args.get("limit") or 100)
    offset = int(args.get("offset") or 0)
    conn = _connect()
    try:
        where, params = "", []
        if level:
            where = "WHERE level = ?"
            params.append(level)
        total = conn.execute(
            f"SELECT COUNT(*) FROM groups {where}", params
        ).fetchone()[0]
        rows = conn.execute(
            f"SELECT * FROM groups {where} ORDER BY confidence DESC, group_id "
            f"LIMIT ? OFFSET ?",
            params + [limit, offset],
        ).fetchall()
        groups = []
        for r in rows:
            g = dict(r)
            try:
                g["runs"] = json.loads(g.pop("runs_json") or "[]")
            except (json.JSONDecodeError, TypeError):
                g["runs"] = []
            for side in ("scene_a", "scene_b"):
                meta = conn.execute(
                    "SELECT title, path, duration FROM scenes WHERE scene_id=?",
                    (g[side],),
                ).fetchone()
                g[side + "_meta"] = dict(meta) if meta else None
            groups.append(g)
        return {"total": total, "limit": limit, "offset": offset, "groups": groups}
    finally:
        conn.close()


# --- opt-in write-back (never automatic; only on explicit user action) ------ #
_LEVEL_TAG = {
    "DUPLICATE": "PartialDup: Duplicate",
    "PART": "PartialDup: Part",
    "CUT": "PartialDup: Cut/Montage",
}


def _fmt_ts(s):
    s = int(max(0, round(s or 0)))
    return f"{s // 60}:{s % 60:02d}"


def _find_or_create_tag(sc, name):
    data = _gql_data(
        sc,
        "query($n:String!){findTags(tag_filter:{name:{value:$n,modifier:EQUALS}})"
        "{tags{id}}}",
        {"n": name},
    )
    tags = (data.get("findTags") or {}).get("tags") or []
    if tags:
        return tags[0]["id"]
    data = _gql_data(sc, "mutation($n:String!){tagCreate(input:{name:$n}){id}}", {"n": name})
    return (data.get("tagCreate") or {}).get("id")


def action_apply(args):
    """Opt-in: tag both scenes, add scene markers for matched ranges on the
    longer scene, and record the relationship in a custom field. Manual only."""
    gid = args.get("group_id")
    if gid is None:
        raise PdcError("missing group_id")
    if not _SERVER_CONNECTION:
        raise PdcError("no server_connection (run inside Stash)")
    sc = _SERVER_CONNECTION
    conn = _connect()
    try:
        row = conn.execute("SELECT * FROM groups WHERE group_id=?", (gid,)).fetchone()
        if not row:
            raise PdcError(f"group {gid} not found")
        level, a, b = row["level"], row["scene_a"], row["scene_b"]
        try:
            runs = json.loads(row["runs_json"] or "[]")
        except (json.JSONDecodeError, TypeError):
            runs = []

        tag_name = _LEVEL_TAG.get(level, "PartialDup")
        tag_id = _find_or_create_tag(sc, tag_name)
        # Additive tag on both scenes (bulk ADD never clobbers existing tags).
        _gql_data(
            sc,
            "mutation($ids:[ID!],$t:BulkUpdateIds){bulkSceneUpdate(input:"
            "{ids:$ids,tag_ids:$t}){id}}",
            {"ids": [str(a), str(b)], "t": {"mode": "ADD", "ids": [tag_id]}},
        )

        # Markers on the longer/containing scene at each matched range.
        markers, warnings = 0, []
        for r in runs[:25]:
            try:
                inp = {
                    "scene_id": str(a),
                    "seconds": float(r.get("a_start", 0)),
                    "title": f"{tag_name} ↔ scene {b} "
                             f"({_fmt_ts(r.get('b_start'))}-{_fmt_ts(r.get('b_end'))})",
                    "primary_tag_id": tag_id,
                }
                end = float(r.get("a_end", 0))
                if end > inp["seconds"]:
                    inp["end_seconds"] = end
                _gql_data(
                    sc,
                    "mutation($i:SceneMarkerCreateInput!){sceneMarkerCreate(input:$i){id}}",
                    {"i": inp},
                )
                markers += 1
            except PdcError as e:
                warnings.append(f"markers: {e}")
                break  # likely an unsupported field — stop trying

        # Relationship metadata on the shorter scene (best effort).
        try:
            payload = json.dumps({
                "level": level, "source_scene": a, "confidence": row["confidence"],
                "coverage_b": row["coverage_b"], "ranges": runs,
            })
            _gql_data(
                sc,
                "mutation($i:SceneUpdateInput!){sceneUpdate(input:$i){id}}",
                {"i": {"id": str(b), "custom_fields": {"partial": {"partial_dup": payload}}}},
            )
        except PdcError as e:
            warnings.append(f"custom_field: {e}")

        conn.execute("UPDATE groups SET applied=1 WHERE group_id=?", (gid,))
        conn.commit()
        return {"applied": True, "group_id": gid, "tag": tag_name,
                "markers": markers, "warnings": warnings}
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# Scene enumeration (GraphQL)
# --------------------------------------------------------------------------- #
def _enumerate_scenes(server_connection):
    """Page through findScenes, returning lightweight scene descriptors.

    Each: {id, title, path, duration, oshash, phash, sprite_url, vtt_url}.
    """
    query = """
    query($page:Int!) {
      findScenes(filter:{per_page:200, page:$page, sort:"id", direction:ASC}) {
        count
        scenes {
          id
          title
          files { path duration fingerprints { type value } }
          paths { sprite vtt }
        }
      }
    }
    """
    base = _stash_base_url(server_connection)
    out = []
    page = 1
    while True:
        data = _gql_data(server_connection, query, {"page": page})
        block = (data or {}).get("findScenes") or {}
        scenes = block.get("scenes") or []
        if not scenes:
            break
        for s in scenes:
            files = s.get("files") or []
            f0 = files[0] if files else {}
            fps = {fp.get("type"): fp.get("value") for fp in (f0.get("fingerprints") or [])}
            sprite = (s.get("paths") or {}).get("sprite")
            vtt = (s.get("paths") or {}).get("vtt")
            out.append({
                "id": int(s["id"]),
                "title": s.get("title") or "",
                "path": f0.get("path") or "",
                "duration": f0.get("duration") or 0.0,
                "oshash": fps.get("oshash"),
                "phash": fps.get("phash"),
                "sprite_url": _abs_url(base, sprite),
                "vtt_url": _abs_url(base, vtt),
            })
        if len(out) >= (block.get("count") or 0):
            break
        page += 1
    return out


def _abs_url(base, maybe_url):
    if not maybe_url:
        return None
    if maybe_url.startswith("http://") or maybe_url.startswith("https://"):
        return maybe_url
    return base + maybe_url if maybe_url.startswith("/") else f"{base}/{maybe_url}"


# --------------------------------------------------------------------------- #
# Worker loop  (Phase 1: enumerate; fingerprint/match added in later phases)
# --------------------------------------------------------------------------- #
def _worker_loop(server_connection):
    _log(f"worker started pid={os.getpid()}")
    conn = _connect()
    try:
        cfg = _get_config(conn)
        ffmpeg, _ = _ffmpeg_paths(cfg)
        # 'deep' mode deep-indexes everything; 'fast'/'hybrid' build the fast
        # (sprite) index and deep-confirm candidates later during matching.
        primary = "deep" if cfg.get("mode") == "deep" else "fast"

        _set_status(conn, running=True, phase="enumerating", worker_pid=os.getpid(),
                    scenes_done=0, errors=0)
        scenes = _enumerate_scenes(server_connection)
        _set_status(conn, scenes_total=len(scenes), phase="indexing")
        _log(f"enumerated {len(scenes)} scenes; indexing pass={primary}")

        done = errors = total_segments = 0
        for s in scenes:
            try:
                n = _index_scene(conn, s, primary, cfg, server_connection, ffmpeg)
                # Fast pass empty (no sprite) → fall back to deep if available.
                if n == 0 and primary == "fast" and ffmpeg:
                    n = _index_scene(conn, s, "deep", cfg, server_connection, ffmpeg)
                total_segments += n
            except Exception as e:
                errors += 1
                _log(f"index scene {s.get('id')} failed: {type(e).__name__}: {e}")
                # As a fallback, try the deep pass when the fast pass errored.
                if primary == "fast" and ffmpeg:
                    try:
                        total_segments += _index_scene(
                            conn, s, "deep", cfg, server_connection, ffmpeg)
                        errors -= 1
                    except Exception as e2:
                        _log(f"  deep fallback also failed: {e2}")
            done += 1
            if done % 5 == 0 or done == len(scenes):
                _set_status(conn, scenes_done=done, errors=errors,
                            segments=total_segments)

        _set_status(conn, scenes_done=done, errors=errors, segments=total_segments,
                    phase="matching")
        _log(f"indexed {done} scenes, {total_segments} segments, {errors} errors")

        groups = _match_and_classify(conn, cfg, server_connection, ffmpeg)

        _set_status(conn, running=False, phase="done", groups=groups,
                    finished_at=time.time())
    except Exception as e:
        _log(f"worker error: {type(e).__name__}: {e}")
        try:
            _set_status(conn, running=False, phase="error", error=str(e))
        except Exception:
            pass
    finally:
        conn.close()
    _log("worker finished")


# --------------------------------------------------------------------------- #
# Dispatch
# --------------------------------------------------------------------------- #
ACTIONS = {
    "check": action_check,
    "get_config": action_get_config,
    "set_config": action_set_config,
    "scan": action_scan,
    "scan_status": action_scan_status,
    "results": action_results,
    "apply": action_apply,
    "reset": action_reset,
}


def main():
    try:
        raw = sys.stdin.buffer.read().decode("utf-8")
    except Exception:
        raw = sys.stdin.read()
    if not raw.strip():
        _write(None, "empty stdin")
        return

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        _write(None, f"invalid JSON: {e}")
        return

    args = payload.get("args") if isinstance(payload, dict) and "args" in payload else payload
    if not isinstance(args, dict):
        _write(None, "args must be an object")
        return

    global _SERVER_CONNECTION
    if isinstance(payload, dict) and isinstance(payload.get("server_connection"), dict):
        _SERVER_CONNECTION = payload["server_connection"]

    action = args.get("action")
    if not action:
        _write(None, "missing 'action'")
        return

    # Detached worker is not a request/response action — it runs the pipeline and
    # writes progress to the DB until done.
    if action == "__worker":
        _worker_loop(_SERVER_CONNECTION)
        sys.exit(0)

    handler = ACTIONS.get(action)
    if not handler:
        _write(None, f"unknown action '{action}'. valid: {sorted(ACTIONS)}")
        return

    try:
        result = handler(args)
        _write(result, None)
    except PdcError as e:
        _write(None, str(e))
    except Exception as e:
        _write(None, f"unhandled error: {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
