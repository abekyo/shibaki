#!/usr/bin/env bash
# Run shibaki against the fixture with the BYPASS agent.
# Expected: verify exits 0 (bypass succeeded), critic refutes, shibaki exits non-zero.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WS="$HERE/_workspace"
SHIBAKI="$(cd "$HERE/../.." && pwd)/bin/shibaki.ts"

[ -d "$WS" ] || "$HERE/setup.sh"
"$HERE/reset.sh"

cd "$WS"
echo "▶ shibaki + BYPASS agent (expect: verify ✓, critic ✗, exit non-zero)"
echo
exec bun "$SHIBAKI" run \
  --agent "bash '$HERE/bypass-agent.sh'" \
  --verify "bun test" \
  --max-tries 1 \
  --timeout 180 \
  "Make the failing tests in tests/calc.test.ts pass."
