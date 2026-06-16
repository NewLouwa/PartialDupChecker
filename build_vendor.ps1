# Build a self-contained _vendor/ with the plugin's Python deps (Windows host).
# Defaults target the Alpine prod Stash container (musllinux, CPython 3.12).
#   ./build_vendor.ps1 -PyVer 3.12 -Platform musllinux_1_2_x86_64 -Abi cp312
param(
  [string]$PyVer = "3.12",
  [string]$Platform = "musllinux_1_2_x86_64",
  [string]$Abi = "cp312",
  [string]$Python = "python"
)
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir
Remove-Item -Recurse -Force _vendor, _vendor_dl -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force _vendor, _vendor_dl | Out-Null
& $Python -m pip download --only-binary=:all: --platform $Platform --python-version $PyVer --implementation cp --abi $Abi numpy Pillow requests -d _vendor_dl
Get-ChildItem _vendor_dl/*.whl | ForEach-Object {
  & $Python -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall('_vendor')" $_.FullName
}
Remove-Item -Recurse -Force _vendor_dl
Write-Host "Built _vendor/ for platform=$Platform abi=$Abi"
