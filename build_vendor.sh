#!/usr/bin/env bash
# Build a self-contained _vendor/ with the plugin's Python deps so it installs
# without a separate pip/apk step. Defaults target the Alpine prod Stash
# container (musllinux, CPython 3.12). Override for other targets, e.g.:
#   PYVER=3.11 PLATFORM=win_amd64 ABI=cp311 ./build_vendor.sh
#
# _vendor is added to sys.path as a FALLBACK (see partialdup.py), so the same
# folder is safe on any platform: a host with the deps installed ignores it.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
PY="${PYTHON:-python3}"
PYVER="${PYVER:-3.12}"
PLATFORM="${PLATFORM:-musllinux_1_2_x86_64}"
ABI="${ABI:-cp312}"

rm -rf _vendor _vendor_dl
mkdir -p _vendor _vendor_dl
"$PY" -m pip download --only-binary=:all: \
  --platform "$PLATFORM" --python-version "$PYVER" --implementation cp --abi "$ABI" \
  numpy Pillow requests -d _vendor_dl
for w in _vendor_dl/*.whl; do
  "$PY" -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall('_vendor')" "$w"
done
rm -rf _vendor_dl
echo "Built _vendor/ for platform=$PLATFORM abi=$ABI ($(du -sh _vendor | cut -f1))"
