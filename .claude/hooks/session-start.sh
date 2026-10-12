#!/bin/bash
# Install dependencies for Claude Code cloud sessions so build/typecheck/tests work immediately.
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "$CLAUDE_PROJECT_DIR"
npm ci --no-audit --no-fund
