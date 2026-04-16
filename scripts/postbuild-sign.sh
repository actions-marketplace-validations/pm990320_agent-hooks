#!/usr/bin/env bash
# Re-sign the freshly-compiled darwin binary as ad-hoc so the CDHash
# matches the on-disk bytes after the file is later copied / renamed
# to another path on the user's machine. Bun's `--compile` emits a
# linker-signed ad-hoc signature, but that signature's validity can
# be flagged as "modified" by Gatekeeper/amfid once the file moves
# across inodes — the symptom is macOS hanging the process in
# _dyld_start on first exec at the new path, and
# `spctl -a -vvv` reporting "invalid signature (code or signature
# have been modified)".
#
# Re-signing after the build produces a self-consistent ad-hoc
# signature that's portable across paths (the CDHash is derived
# purely from the final binary bytes, with no linker-side metadata).
#
# No-op on non-darwin hosts (linux and windows binaries don't need
# this; Windows has its own Authenticode thing but `--compile`'s
# output works without it).
set -euo pipefail

BIN="${1:-./bin/agent-hooks}"

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

if ! command -v codesign >/dev/null 2>&1; then
  echo "postbuild-sign: codesign not found, skipping" >&2
  exit 0
fi

if [ ! -f "$BIN" ]; then
  echo "postbuild-sign: $BIN not found, skipping" >&2
  exit 0
fi

# Remove-then-sign: `codesign -fs -` alone fails on bun's output with
# "invalid or unsupported format for signature" (the linker-signed
# LC_CODE_SIGNATURE load command confuses codesign's rewrite path).
# Removing it first gets codesign to a clean state it can sign.
codesign --remove-signature "$BIN" 2>/dev/null || true
codesign -fs - --force --deep "$BIN"
