# Changelog

All notable changes to this project are documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.11.0] - 2026-07-10

### Added
- **Images: keep modes** like videos - Largest (default), Newest, Oldest
  (created date) or Manual (free selection: every tile, the largest
  included, gets a checkbox; per-cluster delete buttons hide since there is
  no keeper rule). Per-tile Keep buttons override the mode per group.
- **Images: Match filter** (Normal / Strict / Exact) applied at view time
  over the stored pairs - Exact shows identical-phash groups only (tiles get
  a red "exact" badge), Strict means distance <= 2, Normal the configured
  threshold. Switching is instant, no re-scan.
- **Images: global "Select all duplicates (N)"** following the active keep
  mode, next to the existing Delete-all button (both hidden in Manual).

### Fixed
- **Image duplicate threshold now applies without a re-scan**: clusters are
  filtered by the CURRENT `image_dup_hamming` (and the Match filter) at view
  time, instead of showing whatever the last scan stored. Note: raising the
  threshold beyond the last scan's value still needs a re-scan.
- Scene info fetch (dates/quality) retries a couple of times when Stash's
  database is briefly locked during a scan, instead of silently giving up.
- Picking an image keeper now also unticks it from the delete selection
  (same protection videos already had).

### Changed
- The confusing gallery "dry-run" toggle is now an explicit ON/OFF switch:
  "Group similar images into galleries" (OFF = scan only reports).

## [0.10.0] - 2026-07-10

### Added
- **Keep mode "Best quality"** (videos): keeps the highest-quality file of
  each group - resolution first, bitrate then file size as tiebreaks
  (fetched live from Stash). Resolution now shows next to the duration and
  date on every row.
- **Meta button on every row** (auto modes): copies that file's metadata -
  title, details, date, studio, performers, tags, URLs, rating - onto the
  KEEP file and renames the KEEP file after the source (extension kept).
  Performers/tags/URLs are merged, the rest overwrites; one confirmation per
  click, backed by a new `transfer_metadata` action. The plugin's own index
  is synced so the list shows the new name without a re-scan.

## [0.9.0] - 2026-07-10

### Changed
- **Manual mode is now true free selection**: no protected keeper - every
  file of every group, the longest included, gets a checkbox (this is what
  Manual was always meant to be). The group header shows "MANUAL - free
  selection" and per-row Keep buttons are hidden in this mode. The delete
  confirmation says exactly what will happen.

### Added
- **"Select all duplicates (N)" button** in the Keep bar: one click ticks
  every non-kept file of every visible group, following the active keep
  mode (Longest/Newest/Oldest, including per-group Keep overrides). Not
  shown in Manual mode, which has no keeper rule.

## [0.8.0] - 2026-07-10

### Added
- **"Top bar access" native setting** (Settings > Plugins): choose server-wide
  how the plugin appears in the top bar - `both` (menu entry + right-side
  icon), `menu`, or `icon`. The per-browser Navbar option in the in-page
  panel now overrides it, with a new "Follow Settings > Plugins" choice
  (showing the current server value) to hand control back.

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
