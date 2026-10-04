#!/bin/sh
# Install the yrm binary from a GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/YAGNI-App/YRM/main/scripts/install.sh | sh
#
# Environment:
#   YRM_VERSION      release tag to install, e.g. v0.1.0 (default: the latest release)
#   YRM_INSTALL_DIR  where to put `yrm` (default: ~/.local/bin)
#   YRM_DOWNLOAD_BASE  URL holding the assets, overriding the GitHub release (mirrors, testing)
#
# Downloads yrm-bun-<os>-<arch> and SHA256SUMS from the release, checks the
# binary against its checksum, and refuses to install on a mismatch.
# Windows: download yrm-bun-windows-x64.exe from the release page instead.
set -eu

REPO="YAGNI-App/YRM"
VERSION="${YRM_VERSION:-latest}"
INSTALL_DIR="${YRM_INSTALL_DIR:-$HOME/.local/bin}"

fail() {
  echo "install.sh: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "needs $1"
}

detect_target() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) fail "unsupported OS: $os (Windows: download yrm-bun-windows-x64.exe from https://github.com/$REPO/releases)" ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "unsupported architecture: $arch" ;;
  esac
  # A shell under Rosetta reports x86_64 on Apple silicon; the native build is faster.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
    arch=arm64
  fi
  # The Linux builds link against glibc.
  if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
    fail "musl libc (e.g. Alpine) is not supported by the release binaries; use the Docker image or build from source"
  fi
  echo "bun-$os-$arch"
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    fail "needs sha256sum or shasum to verify the download"
  fi
}

main() {
  need curl
  target=$(detect_target)
  asset="yrm-$target"
  if [ -n "${YRM_DOWNLOAD_BASE:-}" ]; then
    base="$YRM_DOWNLOAD_BASE" # a mirror, or a local directory served over HTTP for testing
  elif [ "$VERSION" = latest ]; then
    base="https://github.com/$REPO/releases/latest/download"
  else
    base="https://github.com/$REPO/releases/download/$VERSION"
  fi

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT INT TERM

  echo "downloading $asset ($VERSION)"
  curl -fsSL --retry 3 -o "$tmp/$asset" "$base/$asset" || fail "could not download $base/$asset (has a release been published?)"
  curl -fsSL --retry 3 -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || fail "could not download $base/SHA256SUMS"

  expected=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")
  [ -n "$expected" ] || fail "$asset is not listed in SHA256SUMS"
  actual=$(sha256 "$tmp/$asset")
  [ "$expected" = "$actual" ] || fail "checksum mismatch for $asset: expected $expected, got $actual"

  mkdir -p "$INSTALL_DIR"
  chmod 755 "$tmp/$asset"
  mv "$tmp/$asset" "$INSTALL_DIR/yrm"
  echo "installed $("$INSTALL_DIR/yrm" --version) to $INSTALL_DIR/yrm"

  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *) echo "note: $INSTALL_DIR is not on your PATH; add it, e.g. export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
  esac
}

main
