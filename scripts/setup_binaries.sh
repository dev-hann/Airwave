#!/usr/bin/env bash
# Download runtime binaries (yt-dlp, ffmpeg, ffprobe, deno) into ./bin for
# bare-metal/local development. Docker deployments do NOT need this — the image
# bakes binaries in at build time.
#
# Usage:
#   ./scripts/setup_binaries.sh           # install everything (skips present ffmpeg/ffprobe)
#   ./scripts/setup_binaries.sh --force   # re-download everything
#   ./scripts/setup_binaries.sh yt-dlp    # single component
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
BIN_DIR="$ROOT_DIR/bin"
mkdir -p "$BIN_DIR"

FORCE=0
[[ "${1:-}" == "--force" ]] && { FORCE=1; shift; }
ONLY="${1:-all}"

arch_ok() {
  case "$(uname -m)" in
    x86_64|amd64|aarch64|arm64) return 0 ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; return 1 ;;
  esac
}

os_arch_asset() {
  # sets ASSET_<os>_<kind> names for linux/darwin
  ARCH="$(uname -m)"
  case "$(uname -s)" in
    Linux)  OS_KIND="linux" ;;
    Darwin) OS_KIND="macos" ;;
    *) echo "Unsupported OS: $(uname -s)" >&2; return 1 ;;
  esac
}

want() { [[ "$ONLY" == "all" || "$ONLY" == "$1" ]]; }

# ---------------------------------------------------------------- yt-dlp ----
install_yt_dlp() {
  local target="${AIRWAVE_YT_DLP_PATH:-$BIN_DIR/yt-dlp}"
  mkdir -p "$(dirname "$target")"
  local asset
  case "$(uname -s)/$(uname -m)" in
    Linux/x86_64|Linux/amd64)   asset="yt-dlp_linux" ;;
    Linux/aarch64|Linux/arm64)  asset="yt-dlp_linux_aarch64" ;;
    Darwin/*)                   asset="yt-dlp_macos" ;;  # universal executable
    *) echo "Unsupported platform for yt-dlp" >&2; return 1 ;;
  esac
  local url="https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}"
  echo "Downloading yt-dlp from ${url}"
  curl -fsSL -L --retry 3 --retry-delay 2 "$url" -o "$target"
  chmod +x "$target"
  "$target" --version
  echo "Installed yt-dlp to $target"
}

# ---------------------------------------------------------------- ffmpeg ----
install_ffmpeg() {
  local target="${AIRWAVE_FFMPEG_PATH:-$BIN_DIR/ffmpeg}"
  mkdir -p "$(dirname "$target")"
  if [[ $FORCE -eq 0 ]] && command -v "$target" >/dev/null 2>&1; then
    echo "ffmpeg already present at $target"
    return 0
  fi
  local asset_url
  case "$(uname -s)/$(uname -m)" in
    Linux/x86_64|Linux/amd64)  asset_url="https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linux64-gpl.tar.xz" ;;
    Linux/aarch64|Linux/arm64) asset_url="https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linuxarm64-gpl.tar.xz" ;;
    Darwin/*)
      # yt-dlp/FFmpeg-Builds has no macOS artifacts: prefer PATH, then Homebrew.
      if command -v ffmpeg >/dev/null 2>&1; then
        echo "Using ffmpeg from PATH: $(command -v ffmpeg)"
        cp "$(command -v ffmpeg)" "$target"
      elif command -v brew >/dev/null 2>&1; then
        echo "Installing ffmpeg via Homebrew..."
        brew install ffmpeg || true
        command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg unavailable after brew install" >&2; return 1; }
        cp "$(command -v ffmpeg)" "$target"
      else
        echo "No ffmpeg on PATH and no Homebrew. Install ffmpeg or set AIRWAVE_FFMPEG_PATH." >&2
        return 1
      fi
      chmod +x "$target"
      "$target" -version | head -n 1
      echo "Installed ffmpeg to $target"
      return 0
      ;;
    *) echo "Unsupported platform for ffmpeg" >&2; return 1 ;;
  esac
  local tmp; tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  echo "Downloading ffmpeg from $asset_url"
  curl -fsSL "$asset_url" -o "$tmp/ffmpeg.tar.xz"
  tar -xJf "$tmp/ffmpeg.tar.xz" -C "$tmp"
  local bin; bin="$(find "$tmp" -type f -name ffmpeg | head -n 1)"
  [[ -n "${bin:-}" ]] || { echo "ffmpeg binary not found in archive" >&2; return 1; }
  cp "$bin" "$target"
  chmod +x "$target"
  "$target" -version | head -n 1
  echo "Installed ffmpeg to $target"
}

# --------------------------------------------------------------- ffprobe ----
install_ffprobe() {
  local target="${AIRWAVE_FFPROBE_PATH:-$BIN_DIR/ffprobe}"
  local index_url="${AIRWAVE_FFPROBE_INDEX_URL:-https://ffmpeg.martin-riedl.de/}"
  mkdir -p "$(dirname "$target")"
  if [[ $FORCE -eq 0 ]] && command -v "$target" >/dev/null 2>&1; then
    echo "ffprobe already present at $target"
    return 0
  fi
  local mr_os mr_arch
  case "$(uname -s)" in
    Linux) mr_os="linux" ;; Darwin) mr_os="macos" ;; *) echo "Unsupported OS" >&2; return 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) mr_arch="amd64" ;; aarch64|arm64) mr_arch="arm64" ;; *) echo "Unsupported arch" >&2; return 1 ;;
  esac
  local tmp; tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  _dl_ffprobe() {
    local url="$1"
    echo "Downloading ffprobe from $url"
    rm -rf "$tmp/extract"; mkdir -p "$tmp/extract"
    if ! curl -fsSL -L --retry 3 --retry-delay 2 "$url" -o "$tmp/ffprobe.zip"; then
      return 1
    fi
    unzip -q "$tmp/ffprobe.zip" -d "$tmp/extract"
    local bin; bin="$(find "$tmp/extract" -type f \( -name ffprobe -o -name ffprobe.exe \) | head -n 1)"
    [[ -n "${bin:-}" ]] || { echo "ffprobe binary not found in zip" >&2; return 1; }
    cp "$bin" "$target"
    chmod +x "$target"
    "$target" -version | head -n 1
    echo "Installed ffprobe to $target"
  }

  # Primary: official redirect. Fallback: parse release link from index HTML.
  if _dl_ffprobe "https://ffmpeg.martin-riedl.de/redirect/latest/${mr_os}/${mr_arch}/release/ffprobe.zip"; then
    return 0
  fi
  echo "Redirect download failed, trying parsed index URL…" >&2
  local release rel parsed
  release="$(curl -fsSL "$index_url" | sed -n '/<h2>Download Release Build<\/h2>/,/<h2>Timeline/p')" || return 1
  rel="$(printf '%s\n' "$release" | grep -oE "href=\"(/download/${mr_os}/${mr_arch}/[^\"]+ffprobe\\.zip)\"" | head -n 1 | sed 's/^href="//;s/".*$//')"
  [[ -n "${rel:-}" ]] || { echo "No ffprobe.zip link in $index_url release section" >&2; return 1; }
  case "$rel" in http*) parsed="$rel" ;; *) parsed="${index_url%/}${rel}" ;; esac
  _dl_ffprobe "$parsed"
}

# ------------------------------------------------------------------ deno ----
install_deno() {
  local target="${AIRWAVE_DENO_PATH:-$BIN_DIR/deno}"
  mkdir -p "$(dirname "$target")"
  local asset
  case "$(uname -s)/$(uname -m)" in
    Linux/x86_64|Linux/amd64)   asset="deno-x86_64-unknown-linux-gnu.zip" ;;
    Linux/aarch64|Linux/arm64)  asset="deno-aarch64-unknown-linux-gnu.zip" ;;
    Darwin/x86_64|Darwin/amd64) asset="deno-x86_64-apple-darwin.zip" ;;
    Darwin/aarch64|Darwin/arm64) asset="deno-aarch64-apple-darwin.zip" ;;
    *) echo "Unsupported platform for deno" >&2; return 1 ;;
  esac
  local url="https://github.com/denoland/deno/releases/latest/download/${asset}"
  echo "Downloading deno from $url"
  local tmp; tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  curl -fsSL "$url" -o "$tmp/deno.zip"
  unzip -q "$tmp/deno.zip" -d "$tmp"
  mv "$tmp/deno" "$target"
  chmod +x "$target"
  "$target" --version | head -n 1
  echo "Installed deno to $target"
}

# ------------------------------------------------------------------ main ----
arch_ok || exit 1
status=0
if want yt-dlp; then install_yt_dlp || status=1; fi
if want ffmpeg; then install_ffmpeg || status=1; fi
if want ffprobe; then install_ffprobe || status=1; fi
if want deno; then install_deno || status=1; fi

if [[ "$ONLY" == "all" ]]; then
  echo
  echo "Binaries in ./bin:"
  ls -1 "$BIN_DIR" 2>/dev/null || echo "  (none)"
fi
exit $status
