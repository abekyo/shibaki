#!/usr/bin/env bash
# Shibaki release audit wrapper.
# Run just before OSS push / npm publish / making the repo public.
#
# Order:
#   1. shibaki audit-publish (built-in; covers AI cross-session leaks)
#   2. gitleaks (recommended; install separately)
#   3. Summary
#
# Exits non-zero if either step detects a leak.

set -e

DIR="${1:-.}"
echo "=========================================="
echo "  Release audit: $DIR"
echo "=========================================="

# 1. Shibaki audit-publish
echo ""
echo "[1/2] shibaki audit-publish"
if ! bun run bin/shibaki.ts audit-publish "$DIR"; then
  echo ""
  echo "✗ shibaki audit-publish detected leaks. Release aborted."
  exit 1
fi

# 2. gitleaks (optional but recommended)
echo ""
echo "[2/2] gitleaks (recommended)"
if command -v gitleaks >/dev/null 2>&1; then
  if ! gitleaks detect --source "$DIR" --no-banner 2>&1; then
    echo "✗ gitleaks detected leaks. Release aborted."
    exit 1
  fi
  echo "✓ gitleaks: clean"
else
  echo "⚠️ gitleaks not installed (recommended):"
  echo "    brew install gitleaks"
  echo "    or: https://github.com/gitleaks/gitleaks#installing"
fi

echo ""
echo "=========================================="
echo "  ✓ Release audit passed — safe to push"
echo "=========================================="
