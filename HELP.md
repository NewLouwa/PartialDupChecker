# Partial Duplicate Checker — Help

## Overview

Partial Duplicate Checker finds duplicates that Stash's built-in checker **can't**
see. The built-in checker compares one hash of the *whole* file, so it only catches
near-identical full videos. This plugin builds a fingerprint *timeline* of each video,
so it also finds **clips, cuts, and montages** taken from videos you already have.

It runs **alongside** the built-in checker and **never changes your library** unless
you explicitly delete or tag something.

## Requirements

- `ffmpeg`/`ffprobe` available to Stash.
- Python packages `requests`, `Pillow`, `numpy` (bundled in `_vendor/`, or install them).
- The plugin still loads without the Python packages — the **Check** it runs on the
  page will report anything missing.

## Quick start

1. Open **Partial Dup** from the navigation menu (or the clone icon in the top bar).
2. Click **Scan library**. The scan fingerprints every scene and finds matches. It runs
   in the background, so you can leave the page — progress is shown when you return.
3. Results appear as **boxes**. Each box is one longer video (kept) with the shorter
   clips/duplicates of it listed underneath.
4. Tick the clips you want to remove, then click **Delete N file(s)** and confirm.

## Understanding the results

Each box groups everything related to **one longest video**:

- The video at the top is marked **KEEP · longest** — the most complete copy.
- Below it are the matching shorter scenes, each labelled with a level:

| Level | Meaning |
|------|---------|
| **Duplicate** | The same content end to end (a re-encode, recrop, or rewatermark). |
| **Part** | A contiguous chunk cut out of the longer video. |
| **Cut / Montage** | A partial, reordered, or spliced overlap — a compilation. |

Each clip also shows the **match %** (how much of that clip was found in the longer
video) and the **time range** where it matched.

Use the **All / Duplicate / Part / Cut-Montage** tabs to filter boxes by the kind of
match they contain.

## Deleting duplicates

- Tick the clips you want to remove. The longest video in each box is **not**
  selectable, so you can't delete the copy you're keeping by accident.
- A bar appears: **Delete N file(s)**. It asks for confirmation, then deletes those
  scenes **and their files from disk** (this cannot be undone) and removes them from
  the results.
- Want to keep a different copy instead? Delete the long one from Stash directly; the
  box re-clusters on the next scan.

## Scanning

- The scan runs in a detached background worker, so closing the tab won't stop it.
- The **first** scan is the slowest (it fingerprints everything). Re-scans skip scenes
  whose file hasn't changed, so they're much faster.
- Modes (advanced): **fast** reuses Stash's sprite thumbnails (quick, coarse),
  **deep** decodes each video with ffmpeg (accurate, slow), **hybrid** (default) does a
  fast pass then confirms the strongest matches with ffmpeg within a time budget.

## Tuning (false positives / missed matches)

Because it compares image fingerprints, very similar-looking videos can occasionally be
matched even when they're different. The matcher is tunable (via the `set_config`
operation):

- `segment_hamming` — lower = stricter per-frame match (fewer coincidences).
- `cut_min_coverage` — raise to require more overlap before calling something a Cut.
- `min_match_seconds` — require a longer shared run; the single best lever against
  scattered coincidental matches.
- `min_candidate_segs`, `top_k_candidates`, `max_candidate_pairs` — bound how many pairs
  are compared on a large library.

After changing thresholds, run a scan again (it re-matches the existing index — no
re-fingerprinting needed).

## FAQ

**Does it change my library?** No. Scanning only reads. Tags, markers, and deletes
happen only when you click them.

**Why isn't it a tab inside the built-in Duplicate Checker page?** Stash 0.31 doesn't
allow plugins to patch that page, so this lives as its own page in the nav instead.

**A video I expected is missing.** It may have no generated sprite and an unreadable
file, or it shares too little to pass the match threshold. The plugin log lists scenes
it couldn't index.

## Troubleshooting

- **Scan looks stuck** (status says running but nothing moves): a **Reset stuck scan**
  button appears when the worker is no longer alive — click it, then scan again.
- **Check reports a missing dependency**: install `requests` / `Pillow` / `numpy` for
  the Python that runs the plugin (or use the bundled `_vendor/`).
- **Unrelated videos matched**: tighten the thresholds above and re-scan.
