#!/usr/bin/env bash
set -euo pipefail

# Example only for large Rails repos:
# 1) Run rubocop only on changed Ruby files.
# 2) Optionally run a targeted spec subset.

cd "${1:-.}"

CHANGED_RB_FILES="$(git diff --name-only origin/main...HEAD | rg '\\.rb$' || true)"

if [ -n "$CHANGED_RB_FILES" ]; then
  echo "Running Rubocop on changed files..."
  bundle exec rubocop --parallel $CHANGED_RB_FILES
else
  echo "No changed Ruby files detected; skipping Rubocop."
fi

# Optional targeted spec command example:
# DISABLE_SIMPLECOV=1 RANDOM_SPEC=0 bundle exec rspec spec/services

echo "Fast validation example completed."
