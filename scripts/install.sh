#!/usr/bin/env bash
# agent-hooks installer.
#
# Usage:
#   curl -fsSL https://agent-hooks.dev/install.sh | sh
#   curl -fsSL https://agent-hooks.dev/install.sh | sh -s -- --version v0.1.0
#   curl -fsSL https://agent-hooks.dev/install.sh | sh -s -- --dir /usr/local/bin
#
# Downloads the prebuilt binary for the current OS + arch from the
# latest GitHub release (or a pinned version), verifies it runs, and
# installs it into the user's chosen directory.
set -euo pipefail

REPO="pm990320/agent-hooks"
VERSION="latest"
INSTALL_DIR="${HOME}/.local/bin"

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 64 ;;
  esac
done

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;;
esac

case "$OS" in
  linux) ASSET="agent-hooks-linux-$ARCH" ;;
  darwin) ASSET="agent-hooks-darwin-$ARCH" ;;
  *) echo "Unsupported OS: $OS (use the GitHub Action for Windows runners)" >&2; exit 1 ;;
esac

if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/$REPO/releases/latest/download/$ASSET"
else
  URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET"
fi

mkdir -p "$INSTALL_DIR"
TARGET="$INSTALL_DIR/agent-hooks"
echo "Downloading $URL"
curl -fL "$URL" -o "$TARGET"
chmod +x "$TARGET"

if ! "$TARGET" --version >/dev/null 2>&1; then
  echo "Installed binary failed to run. Removing." >&2
  rm -f "$TARGET"
  exit 1
fi

echo "✓ installed agent-hooks to $TARGET"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo
    echo "Note: $INSTALL_DIR is not on your PATH."
    echo "Add this to your shell profile:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac
