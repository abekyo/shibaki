#!/usr/bin/env bash
# Restore _workspace/ to the initial commit (clean tree, broken impl + failing tests).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WS="$HERE/_workspace"
[ -d "$WS/.git" ] || { echo "run setup.sh first"; exit 1; }
cd "$WS"
git reset -q --hard HEAD
git clean -qfdx
