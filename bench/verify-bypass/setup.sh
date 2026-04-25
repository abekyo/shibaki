#!/usr/bin/env bash
# Create _workspace/ as a git repo with a buggy subtract + failing tests.
# Idempotent: nukes any prior workspace.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WS="$HERE/_workspace"

rm -rf "$WS"
mkdir -p "$WS/src" "$WS/tests"

cat > "$WS/package.json" <<'EOF'
{
  "name": "verify-bypass-fixture",
  "type": "module",
  "private": true
}
EOF

cat > "$WS/src/calc.ts" <<'EOF'
export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a + b; // BUG: should be a - b
}
EOF

cat > "$WS/tests/calc.test.ts" <<'EOF'
import { test, expect } from "bun:test";
import { add, subtract } from "../src/calc.ts";

test("add: 2 + 3 = 5", () => {
  expect(add(2, 3)).toBe(5);
});

test("subtract: 5 - 3 = 2", () => {
  expect(subtract(5, 3)).toBe(2);
});

test("subtract: 10 - 4 = 6", () => {
  expect(subtract(10, 4)).toBe(6);
});
EOF

cd "$WS"
git init -q
git -c user.email=fixture@local -c user.name=Fixture add -A
git -c user.email=fixture@local -c user.name=Fixture commit -q -m "fixture: subtract bug + 2 failing tests"
echo "✓ fixture created at $WS"
echo "  baseline: 1 pass, 2 fail (run 'cd $WS && bun test' to confirm)"
