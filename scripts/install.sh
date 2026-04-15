#!/usr/bin/env bash
# agent-hooks installer.
#
# Usage:
#   curl -fsSL https://github.com/pm990320/agent-hooks/releases/latest/download/install.sh | sh
#   curl -fsSL https://github.com/pm990320/agent-hooks/releases/latest/download/install.sh | sh -s -- --version v0.1.0
#   curl -fsSL https://github.com/pm990320/agent-hooks/releases/latest/download/install.sh | sh -s -- --dir /usr/local/bin
#
# Downloads the prebuilt binary for the current OS + arch from the
# latest GitHub release (or a pinned version), verifies it runs, and
# installs it into a standard bin directory on $PATH.
#
# Install directory resolution (first match wins):
#   1. --dir <path>                (explicit flag)
#   2. $AGENT_HOOKS_BIN_DIR        (env var, handy for CI scripting)
#   3. $XDG_BIN_HOME               (XDG Base Directory spec)
#   4. A standard candidate that is writable-without-sudo AND on $PATH:
#        ~/.local/bin, /usr/local/bin, ~/bin
#   5. First candidate that is merely writable
#   6. ~/.local/bin (created if missing), with a PATH-warning fallback
set -euo pipefail

REPO="pm990320/agent-hooks"
VERSION="latest"
EXPLICIT_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --dir) EXPLICIT_DIR="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 64 ;;
  esac
done

# --- Install directory resolution ---------------------------------------

dir_on_path() {
  case ":$PATH:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

# True if we could copy a file into $1 without sudo. Handles both the
# "directory already exists and is writable" and "directory doesn't yet
# exist but a writable ancestor does" cases.
dir_writable() {
  local d="$1"
  if [ -d "$d" ]; then
    [ -w "$d" ]
    return
  fi
  local parent="$d"
  while [ ! -d "$parent" ]; do
    parent=$(dirname "$parent")
  done
  [ -w "$parent" ]
}

resolve_install_dir() {
  if [ -n "$EXPLICIT_DIR" ]; then
    echo "$EXPLICIT_DIR"
    return
  fi
  if [ -n "${AGENT_HOOKS_BIN_DIR:-}" ]; then
    echo "$AGENT_HOOKS_BIN_DIR"
    return
  fi
  if [ -n "${XDG_BIN_HOME:-}" ]; then
    echo "$XDG_BIN_HOME"
    return
  fi

  local candidates=(
    "$HOME/.local/bin"
    "/usr/local/bin"
    "$HOME/bin"
  )

  # Pass 1: first candidate that is writable AND already on $PATH. The
  # binary is immediately runnable from the same shell, no rc-file
  # edits, no re-login.
  for c in "${candidates[@]}"; do
    if dir_writable "$c" && dir_on_path "$c"; then
      echo "$c"
      return
    fi
  done

  # Pass 2: first candidate that is merely writable. The binary works
  # by absolute path, and the PATH warning below tells the user how to
  # add it to their shell.
  for c in "${candidates[@]}"; do
    if dir_writable "$c"; then
      echo "$c"
      return
    fi
  done

  # Last resort: the XDG-compliant location. mkdir -p below creates it.
  echo "$HOME/.local/bin"
}

INSTALL_DIR=$(resolve_install_dir)

# --- OS + arch detection ------------------------------------------------

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

# --- Download + install -------------------------------------------------

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

if ! dir_on_path "$INSTALL_DIR"; then
  echo
  echo "Note: $INSTALL_DIR is not on your PATH."
  echo "Add this to your shell profile:"
  echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
  echo
  echo "Then open a new shell, or run 'hash -r' in the current one."
fi
