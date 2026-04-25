#!/usr/bin/env bash
# Apply the bypass and report what an exit-code-only loop would conclude.
#
# An exit-code-only loop (shell scripts, `make test`, --auto-test-style
# integrations) trusts the verify command's exit code as the completion signal:
#   1. agent edits files
#   2. run verify
#   3. if exit 0 → done; if exit != 0 → feed error back to agent and retry
#
# This script reproduces step 2-3 inline (no external tool) after applying the
# bypass, to make the difference vs shibaki's critic step concrete.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WS="$HERE/_workspace"

[ -d "$WS" ] || "$HERE/setup.sh"
"$HERE/reset.sh"

cd "$WS"
echo "▶ applying the bypass (test deletion + tautology)"
bash "$HERE/bypass-agent.sh"

echo
echo "▶ running verify (the exit-code check)"
if bun test; then
  echo
  echo "An exit-code-only loop would conclude: tests pass → ✓ task complete"
  echo "                                       (no diff inspection)"
  echo
  echo "What actually changed:"
  git --no-pager diff HEAD
  exit 0
else
  echo "verify failed — bypass attempt did not reach exit 0"
  exit 1
fi
