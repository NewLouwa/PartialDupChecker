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

# Vendor-aware import: if a bundled _vendor/ dir sits next to this file (offline
# / Alpine installs), put it first on sys.path so `requests` etc. resolve there.
# Mirrors the MEGA Import plugin so the same file works on Windows + Alpine.
_VENDOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_vendor")
if os.path.isdir(_VENDOR) and _VENDOR not in sys.path:
    sys.path.insert(0, _VENDOR)

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
    "min_band_hits": 2,          # candidate must share >= this many band hits
    "dup_min_coverage": 0.95,    # DUPLICATE: coverage both ways
    "part_min_coverage": 0.90,   # PART: coverage of the shorter clip
    "cut_min_coverage": 0.65,    # CUT/MONTAGE: coverage of the shorter clip
    "cut_min_runs": 2,           # CUT/MONTAGE: >= this many matched runs
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

            k = ctypes.windll.kernel32
            h = k.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
            if not h:
                return False
            code = ctypes.c_ulong()
            k.GetExitCodeProcess(h, ctypes.byref(code))
            k.CloseHandle(h)
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
    fh = _file_hash(scene)
    row = conn.execute(
        "SELECT file_hash, n_segments, mode FROM scenes WHERE scene_id=?", (sid,)
    ).fetchone()
    if row and row["file_hash"] == fh and (row["n_segments"] or 0) > 0 \
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
            band_rows.append((b, bv, sid, idx))

    conn.execute("DELETE FROM segments WHERE scene_id=?", (sid,))
    conn.execute("DELETE FROM hash_bands WHERE scene_id=?", (sid,))
    conn.executemany("INSERT OR REPLACE INTO segments VALUES (?,?,?,?)", seg_rows)
    conn.executemany("INSERT INTO hash_bands VALUES (?,?,?,?)", band_rows)
    conn.execute(
        "INSERT OR REPLACE INTO scenes "
        "(scene_id, file_hash, title, path, duration, n_segments, mode, indexed_at) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (sid, fh, scene["title"], scene["path"], scene["duration"],
         len(timeline), pass_kind, time.time()),
    )
    conn.commit()
    return len(timeline)


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

    pid = _spawn_worker(_SERVER_CONNECTION)

    conn = _connect()
    try:
        _set_status(conn, worker_pid=pid)
    finally:
        conn.close()
    return {"started": True, "worker_pid": pid}


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
            groups.append(g)
        return {"total": total, "limit": limit, "offset": offset, "groups": groups}
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

        # Phase 3 plugs matching + classification in here:
        groups = 0
        if "_match_and_classify" in globals():
            groups = globals()["_match_and_classify"](conn, cfg)

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
