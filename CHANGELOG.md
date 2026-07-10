# Changelog

All notable changes to this project are documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.7.0] - 2026-07-10

### Added
- **Native plugin settings** (Stash Settings > Plugins page): FFmpeg paths and
  decode timeout, image duplicate/similar thresholds, min cluster size, and
  gallery prefix / max-per-scan now live there (yml `settings:` block). The
  backend reads them via GraphQL at config resolution; a value set there wins
  over the same key saved from the in-page panel, and unset values fall back
  as before. Works in both the request process and the detached scan worker.
- **Help rewritten with per-parameter detail**: what each video-scan tunable,
  match threshold, performance cap and image/gallery knob does, its default,
  and when to raise or lower it.

### Changed
- The in-page Settings panel now covers only the video-scan tunables; the
  FFmpeg and Images groups moved to the native plugin page (linked from the
  panel note).

## [0.6.0] - 2026-07-10

### Added
- **Navbar display option** (Settings > "Navbar (this browser)"): show the
  plugin as the full menu entry (icon + "Partial Dup"), as the right-side
  shortcut icon, or both (default). Stored per browser in localStorage;
  applies on the next navigation or page reload.

## [0.5.1] - 2026-07-10

### Changed
- Keep Newest/Oldest now rank by the scene's **created date** in Stash
  (`created_at`), not the file modification time; `mod_time` remains only a
  fallback when `created_at` is missing.

## [0.5.0] - 2026-07-10

### Added
- **Settings panel** (toolbar button) exposing the backend tunables that were
  previously reachable only via the `set_config` API: scan mode
  (hybrid / fast / deep), deep sampling interval, minimum match length,
  segment similarity, per-level match thresholds (Duplicate / Part / Cut),
  performance caps (candidates, deep budgets), ffmpeg/ffprobe paths and
  timeout, and the image/gallery knobs (hamming thresholds, min cluster
  size, gallery prefix, max created per scan). Changes apply to the next
  scan; a note in the panel says so.
- **Reset defaults** button backed by a new `reset_config` plugin action
  (drops every saved override), with a unit test.

## [0.4.0] - 2026-07-10

### Added
- **Videos: four keep modes.** A "Keep:" bar above the video groups picks the
  keeper of every group at once: **Longest** (default), **Newest**, **Oldest**
  (both by file date, fetched live from Stash - no re-scan needed), or
  **Manual** (decide group by group). The per-row green **Keep** button still
  works in every mode as a per-group override ("KEEP - your pick").
- File date shown next to the duration on every row, so you can see what
  Newest/Oldest will pick.
- Safety net: the delete action re-checks the current keepers and never
  deletes one, even if the selection got stale while switching modes.

### Changed
- Switching keep mode clears manual picks and the delete selection (keepers
  are re-derived, so a stale selection could have pointed at a new keeper).

## [0.3.0] - 2026-07-10

### Added
- **Videos: pick which copy to keep.** Every row in a video cluster now has a
  green **Keep** button (same UX as images). The chosen keeper moves to the
  cluster header ("KEEP - your pick"), and the previous longest video drops
  into the list with a checkbox, so it can be selected and deleted like any
  other match. The demoted original keeps a green "Longest" badge.
- "select all" now selects every item in the cluster except the current
  keeper (the original parent included, when it is no longer the keeper).
- Choosing a keeper automatically removes it from the delete selection, so
  the kept copy can never be deleted.

### Fixed
- After deleting a cluster's parent, the group no longer lingers with a ghost
  parent: the chosen keeper (or the first survivor) is promoted to the head
  of the cluster. This also fixes the same issue in image mode.

## [0.2.0] - 2026-06-23

### Added
- Image mode: near-duplicate clusters with per-cluster keeper pick,
  per-cluster delete and a delete-all-duplicates button.
- Auto-collect visually-similar images into Stash galleries (dry-run by
  default), with "ignore images already in a gallery" and per-gallery
  exclusions.
- Native Stash Tasks integration (progress bar + completion notification).

### Fixed
- VideoCard crash (temporal dead zone: `r` referenced in its own
  initializer).
