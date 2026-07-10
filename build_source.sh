#!/usr/bin/env bash
# Build a Stash plugin SOURCE so this plugin installs/updates like the community
# plugins: Settings > Plugins > Available Plugins > Add Source > <URL>/index.yml.
#
# Output: dist/index.yml + dist/partial_dup_checker.zip  (host dist/ at any URL
# Stash can reach). _vendor is bundled so the install is self-contained.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

VERSION="$(grep -m1 '^version:' partial_dup_checker.yml | awk '{print $2}' | tr -d '"')"
DATE="$(date '+%Y-%m-%d %H:%M:%S')"
STAMP="$(date '+%Y%m%d-%H%M%S')"

rm -rf dist
mkdir -p dist

# NOTE: never ship a `manifest` file in the zip - Stash's package manager writes
# its own manifest into the install dir to track the package; shipping one breaks
# the install. _vendor is bundled only when SLIM is unset (the prod image already
# has numpy/Pillow, so a slim zip is the default source build).
FILES="partial_dup_checker.yml partialdup.py partialdup.js partialdup.css README.md HELP.md"
[ -z "${SLIM:-}" ] && [ -d _vendor ] && FILES="$FILES _vendor"

# zip with files at the archive root (Stash extracts into plugins/<id>/)
( zip -r -q dist/partial_dup_checker.zip $FILES )
SHA="$(sha256sum dist/partial_dup_checker.zip | awk '{print $1}')"

cat > dist/index.yml <<YML
- id: partial_dup_checker
  name: Partial Duplicate Checker
  metadata:
    description: Finds partial video duplicates (cuts/parts/montages) and near-duplicate images that Stash's whole-file phash misses. Clusters under the longest video, opt-in delete, and similar-image galleries.
  version: "${VERSION}-${STAMP}"
  date: "${DATE}"
  path: partial_dup_checker.zip
  sha256: ${SHA}
  requires: []
YML

echo "Built dist/ : version ${VERSION}, zip $(du -h dist/partial_dup_checker.zip | cut -f1), sha ${SHA:0:12}..."
echo "Host the dist/ directory and add  <URL>/index.yml  as a Stash plugin source."
