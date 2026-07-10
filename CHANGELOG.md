# Changelog

All notable changes to this project are documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
