#!/usr/bin/env bash
# Publish the new import, preserving the last branch on a rejected update.
set -euo pipefail

ref=refs/heads/imports
remote=$(git ls-remote origin "$ref")
previous=${remote%%$'\t'*}

push_import() {
  local expected=$1 delay
  for delay in 0 2 8; do
    sleep "$delay"
    if git push --force-with-lease="$ref:$expected" origin "HEAD:$ref"; then
      return 0
    fi
  done
  return 1
}

if [[ -n "$previous" ]]; then
  git fetch --depth 1 origin "$previous"
  if ! git diff --quiet "$previous" HEAD -- .github/workflows; then
    # GITHUB_TOKEN cannot update an existing ref when its workflows would change.
    # Upload the replacement first and use a lease so an intervening write survives.
    candidate="refs/heads/import-candidate-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
    git push origin "HEAD:$candidate"
    git push --force-with-lease="$ref:$previous" origin ":$ref"
    if ! push_import ''; then
      git push --force-with-lease="$ref:" origin "$previous:$ref" ||
        echo "::error::Failed to restore $ref; the replacement is available at $candidate."
      exit 1
    fi
    git push origin ":$candidate" ||
      echo "::warning::Could not remove the published import candidate $candidate."
    exit 0
  fi
fi

push_import "$previous"
