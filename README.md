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

### Option A - plugin source (recommended)

Install and update through Stash's plugin manager, like community plugins.

In Stash: **Settings ▸ Plugins ▸ Available Plugins ▸ Add Source**, then enter:

| Field | Value |
|---|---|
| Name | `CyzLab` |
| Source URL | `https://raw.githubusercontent.com/NewLouwa/PartialDupChecker/source/index.yml` |
| Local Path | `cyzlab` |

Then tick **Partial Duplicate Checker** under the new source and click **Install**.
Updates show up in **Installed Plugins** whenever a new build is published.

> ⚠️ **The Source URL must be exactly the `raw.githubusercontent.com/…/source/index.yml`
> URL above** — with `/source/` (the branch) in the path. Do **not** paste the repo
> page (`github.com/NewLouwa/PartialDupChecker`) or a `/blob/` link: Stash would
> fetch an HTML page and fail with
> `yaml: line 35: mapping values are not allowed in this context`.

Dependencies on the Stash host: `requests`, `Pillow`, `numpy`, and
`ffmpeg`/`ffprobe` (see below). The source package is slim - it does not bundle
`_vendor/`.

### Option B - manual copy

1. Copy this folder's files into your Stash plugins directory as
   `…/plugins/partial_dup_checker/`, or run the installer:
   - Windows: `./install.ps1`
   - Linux/macOS: `./install.sh` (or `./install.sh user@host` to deploy over SSH)
2. In Stash: **Settings ▸ Plugins ▸ Reload Plugins**.

### Dependencies

`requests`, `Pillow`, `numpy`, and `ffmpeg`/`ffprobe`.
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

Open **Partial Dup** from the main nav menu (or the navbar icon), then:

1. Pick **Videos** or **Images** at the top and click **Scan**. The scan runs in
   a detached background worker (also available in Settings ▸ Tasks ▸ Plugin
   Tasks), so it keeps going if you close the tab; progress shows live.
2. Each box is one group of duplicates. The header shows the copy to **KEEP** —
   by default the longest video / largest image. Filter videos by tab:
   **All / Duplicate / Part / Cut-Montage**.
3. **Videos: pick a keep mode.** The **Keep:** bar applies a rule to every
   group at once — **Longest** (default), **Newest** or **Oldest** (by the
   scene's created date in Stash), or **Manual** to decide group by group.
4. **Not the copy you want?** Click the green **Keep** button on any other row
   (works in every mode) — it becomes the keeper, and the previous one drops
   into the list where it can be selected like any other match.
5. Tick the copies to remove and click **Delete**. The keeper is never
   selectable, so you can't delete what you're keeping. Deletion removes files
   from disk and is the **only** thing that writes to your library — scanning
   never modifies anything.

Image mode can also auto-collect visually-similar (non-identical) images into
Stash galleries — dry-run by default; flip the toggle to actually create them.

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
