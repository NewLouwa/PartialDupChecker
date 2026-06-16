# PartialDupChecker — technical notes

## Pipeline

```
enumerate scenes (GraphQL findScenes)
   → fingerprint each scene into an ordered pHash timeline
       fast: fetch sprite sheet + VTT over HTTP, crop each cell, pHash
       deep: ffmpeg samples 1 frame/interval → 32x32 gray → pHash
   → index segments + LSH bands (SQLite)
   → candidate scene pairs (shared band buckets)
   → align each pair (diagonal seed-and-extend) → matched runs
   → classify (coverage / contiguity / order) → Duplicate / Part / Cut / none
   → persist groups; UI reads them; opt-in apply writes tags/markers
```

## Perceptual hash

`_phash_from_gray32` — 64-bit DCT pHash. Resize to 32×32 grayscale, apply a 2-D
DCT (`D @ img @ D.Tᵀ` with a cached cosine basis `_dct_matrix`; per-axis scale
factors are omitted because we threshold against the median, so scaling can't
change the bits — this matches `imagehash.phash` without a scipy dependency),
take the top-left 8×8 block, and set each bit to `coeff > median`. Compared with
Hamming distance (`int.bit_count`). The deep pass pipes raw `gray` frames straight
from ffmpeg (`fps=1/N,scale=32:32,format=gray`, `-f rawvideo`), so no temp files
and no Pillow are needed for decoding.

## Index (SQLite, `PDC_DB` or `<tmp>/.partialdup.sqlite`)

- `scenes(scene_id, file_hash, title, path, duration, n_segments, mode, indexed_at)`
  — skip re-indexing when `file_hash` + `mode` are unchanged.
- `segments(scene_id, idx, t_seconds, phash)` — the ordered timeline. pHashes are
  stored signed (`_u2s`/`_s2u`) because SQLite INTEGER rejects values ≥ 2⁶³.
- `hash_bands(band_no, band_val, scene_id, idx)` + index on `(band_no, band_val)` —
  each 64-bit hash split into `band_count` equal sub-words (default 4×16 bits) for
  LSH candidate retrieval.
- `groups(level, scene_a, scene_b, confidence, coverage_a, coverage_b, runs_json,
  applied, …)` — detected relationships (`scene_a` = the longer/containing scene).

## Candidate retrieval

`_candidate_pairs` buckets every segment by `(band_no, band_val)`. Segments in the
same bucket are near-duplicates; over-popular buckets (blank/black frames) above
`max_bucket` are skipped as non-discriminative. A scene pair is shortlisted when it
shares ≥ `min_candidate_segs` band-matched segments. Band recall only needs to
surface the *pair* — the exact matched segments are recovered by direct-Hamming
alignment, so 4×16 bands (good precision) is fine.

## Alignment

`_align_hashes` seeds matches via B's band buckets, verifies each with direct
Hamming (≤ `segment_hamming`, default 8), then groups seeds by **diagonal**
(`i − j`): a contiguous copy is a run along one diagonal; reordered/spliced montage
pieces fall on different diagonals. Small gaps (`gap_tol`) inside a run are
tolerated. `_select_runs` then greedily keeps the longest, lowest-Hamming runs that
don't overlap in B, so repetitive content yields a clean minimal set of matched
regions (and a meaningful run count) instead of dozens of overlapping ones.

## Classification (`_classify`, all thresholds tunable)

From the selected runs: `coverage_a`, `coverage_b` (distinct matched fraction of
each), `frac_longest_b` (longest single run / len B), `n_sig_runs`, `order_preserved`.

- **DUPLICATE** — `coverage_b ≥ dup_min_coverage` **and** `coverage_a ≥ dup_min_coverage`.
- **PART** — `frac_longest_b ≥ part_min_coverage` (the shorter scene is essentially
  one contiguous chunk of the longer).
- **CUT** — `coverage_b ≥ cut_min_coverage` with ≥ 1 significant run (partial /
  reordered / spliced).
- else **none**.

## Config keys (`get_config` / `set_config`)

`mode` (fast|deep|hybrid), `deep_interval_s`, `segment_hamming`, `band_count`,
`min_candidate_segs`, `min_run_segs`, `gap_tol`, `max_bucket`,
`dup_min_coverage`, `part_min_coverage`, `cut_min_coverage`,
`ffmpeg_path`, `ffprobe_path`.

## Backend actions (`interface: raw`, dispatch on `args["action"]`)

`check`, `scan`, `scan_status`, `results`, `apply`, `get_config`, `set_config`,
and `__worker` (the detached worker). Each prints `{"output":…, "error":…}`;
`runPluginOperation` returns `output` directly and turns a non-null `error` into a
GraphQL error. The scan spawns a **detached** worker (Windows
`DETACHED_PROCESS|CREATE_NEW_PROCESS_GROUP`, POSIX `start_new_session`) that
survives client disconnect and writes progress to the DB `meta` table.

## Known limitations / scaling

- Sprite (fast) granularity is ~30 s, so the fast pass alone misses short cuts —
  hybrid deep-confirms candidates to recover them.
- `_candidate_pairs` is in-memory; for very large libraries the bucket map and
  pairwise accumulation grow — `max_bucket` bounds the worst case but a future
  version should push candidate counting into SQL / shard the index.
- Audio fingerprinting (Chromaprint) is intentionally not used yet — montages
  often replace audio, which would cause false negatives.
