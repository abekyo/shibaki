#!/usr/bin/env bash
# Run shibaki against the fixture with the HONEST agent (control).
# Expected: verify ✓, critic ✓, shibaki exits 0.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WS="$HERE/_workspace"
SHIBAKI="$(cd "$HERE/../.." && pwd)/bin/shibaki.ts"

[ -d "$WS" ] || "$HERE/setup.sh"
"$HERE/reset.sh"

cd "$WS"
echo "▶ shibaki + HONEST agent (expect: verify ✓, critic ✓, exit 0)"
echo
exec bun "$SHIBAKI" run \
  --agent "bash '$HERE/honest-agent.sh'" \
  --verify "bun test" \
  --max-tries 1 \
  --timeout 180 \
  "Make the failing tests in tests/calc.test.ts pass."
