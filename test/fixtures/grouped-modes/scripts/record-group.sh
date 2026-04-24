#!/usr/bin/env bash
set -euo pipefail

label="$1"
shift
dir="$1"
shift

echo "${label} cwd=${PWD} dir=${dir} files=$*"
