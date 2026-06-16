# Partial Duplicate Checker

A Stash plugin that finds the duplicates Stash's built-in checker **can't** —
clips cut out of longer scenes, montages, and re-edits — and sorts them into
three levels. It runs **alongside** the native duplicate checker, never replaces it.

## Why

Stash stores **one perceptual hash per video file** and compares whole files, so
its built-in finder only catches near-identical *full* videos. It is blind to:

- a short clip **cut** out of a longer scene you already have,
- the longer scene that **contains** a clip,
- a **montage / compilation** spliced together from one or more library videos.

Partial Duplicate Checker builds a **per-scene hash timeline** instead of a single
hash, so it can localize *which parts* of two scenes overlap.

## The three levels

| Level | Meaning |
|------|---------|
| **Duplicate** | Same content end-to-end (re-encode, recrop, rewatermark) — a different file with a different whole-file phash, so the native checker misses it. |
| **Part / Contains** | One scene is a contiguous chunk of a longer one (a clip cut from a full scene, or the full scene that contains it). |
| **Cut / Montage** | Partial, reordered, or spliced overlap — a compilation assembled from one or more library videos. |

## Install

1. Copy this folder's files into your Stash plugins directory as
   `…/plugins/partial_dup_checker/`, or run the installer:
   - Windows: `./install.ps1`
   - Linux/macOS: `./install.sh` (or `./install.sh user@host` to deploy over SSH)
2. In Stash: **Settings ▸ Plugins ▸ Reload Plugins**.
3. Dependencies: `requests`, `Pillow`, `numpy`, and `ffmpeg`/`ffprobe`.
   - **Self-contained option:** run `./build_vendor.sh` (or `build_vendor.ps1`) to
     bundle the Python deps into `_vendor/`; the installers copy it along, so no
     pip/apk step is needed on the target. `_vendor/` is a *fallback* — a host that
     already has the deps installed ignores it — so the same bundle is safe on any
     platform. Defaults build musllinux/cp312 wheels for the Alpine Stash container.
   - **Or install normally:** `pip install requests pillow numpy` (Alpine:
     `apk add py3-numpy py3-pillow` + requests).
   - `ffmpeg`/`ffprobe` must be on `PATH` (or set the `ffmpeg_path`/`ffprobe_path`
     config, or `PDC_FFMPEG`/`PDC_FFPROBE` env). The lazy imports mean the plugin
     still loads and `check` works without the deps — it just reports what's missing.

## Use

Open **Partial Duplicate Checker** from the main nav menu (or the navbar icon),
then:

1. Click **Scan library**. The scan runs in a detached background worker, so it
   keeps going if you close the tab; progress shows live.
2. Browse results by tab — **All / Duplicate / Part / Cut-Montage**. Each card
   shows both scenes, the matched time-ranges, and coverage + confidence.
3. **Tag + mark** (per card, optional): adds a `PartialDup: …` tag to both scenes,
   drops scene markers on the matched ranges, and records the relationship in a
   custom field. This is the **only** thing that writes to your library, and only
   when you click it — scanning never modifies anything.

## Fingerprinting modes

Set in the config (`set_config` action / future settings panel):

- **hybrid** (default) — fast pass over Stash's existing sprite thumbnails to
  shortlist candidate pairs, then ffmpeg-decode just those candidates for precise
  matched ranges. Best speed/accuracy on a large library.
- **fast** — sprite thumbnails only (~30 s granularity). Very fast; good for
  whole-video duplicates, misses short cuts.
- **deep** — ffmpeg-decode every scene at a fine cadence. Most accurate, slowest.

## Notes

- It **complements** Stash's built-in checker — keep using that for exact whole-file
  duplicates; use this for the partial cases it can't see.
- Re-scans are incremental: scenes whose file hash is unchanged are skipped.

See [TECHNICAL.md](TECHNICAL.md) for the algorithm, data model, and tuning knobs.
