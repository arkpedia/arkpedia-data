#!/usr/bin/env bash
#
# Keeps the upstream data this repo derives from in .cache/upstream/, so a fresh
# clone of THIS repo plus `npm run stages:refresh` is all that is needed -- no
# sibling checkouts on the machine.
#
# Partial, shallow and sparse: only the paths a script actually reads are ever
# downloaded. Re-running fetches just what moved.
#
# Source it for upstream_sync, or run it as `bash scripts/lib/upstream.sh <args>`,
# which is how a refresh stage calls it.
set -euo pipefail

upstream_dir() { echo ".cache/upstream/$1"; }

# The commit a refresh pinned for a GitHub repository (scripts/content/pin-upstream.mjs),
# read from ARKPEDIA_PIN_<OWNER>_<REPO>; empty when nothing is pinned.
upstream_pin() {
  local slug="${1#https://github.com/}"
  slug="${slug%.git}"
  local variable
  variable="ARKPEDIA_PIN_$(printf '%s' "$slug" | tr '[:lower:]' '[:upper:]' | tr -cs 'A-Z0-9' '_')"
  local commit="${!variable:-}"
  if [[ "$commit" =~ ^[0-9a-f]{40}$ ]]; then echo "$commit"; fi
}

# upstream_sync <name> <url> <ref|default> <path>...
#
# `default` resolves the remote's own default branch, which is not something to
# assume: of the three repos this pulls, two are on main and one on master, and
# passing the wrong one fails at the clone. With a pinned commit for the
# repository, the checkout is that commit rather than the branch head, so every
# stage of one refresh reads the same version however often the mirror moves.
upstream_sync() {
  local name="$1" url="$2" ref="$3"
  shift 3
  local dir commit
  dir="$(upstream_dir "$name")"
  commit="$(upstream_pin "$url")"
  if [ "$ref" = "default" ]; then
    ref="$(git ls-remote --symref "$url" HEAD | awk '/^ref:/ { sub("refs/heads/", "", $2); print $2; exit }')"
    [ -n "$ref" ] || { echo "  cannot resolve a default branch for $url" >&2; return 1; }
  fi
  if [ ! -d "$dir/.git" ]; then
    printf '  cloning %s (%s)\n' "$name" "$ref"
    mkdir -p "$(dirname "$dir")"
    # Not quiet: a failure here used to leave an empty directory and every step
    # after it reading nothing.
    git clone --filter=blob:none --no-checkout --depth 1 --branch "$ref" "$url" "$dir"
    git -C "$dir" sparse-checkout init --cone
  fi
  git -C "$dir" sparse-checkout set "$@"
  # GitHub serves any commit of the repository by its id, not just branch heads.
  git -C "$dir" fetch --depth 1 origin "${commit:-$ref}"
  git -C "$dir" checkout --quiet FETCH_HEAD
  printf '  %s at %s (%s)\n' "$name" "$(git -C "$dir" rev-parse --short HEAD)" "${commit:+pinned }$ref"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then upstream_sync "$@"; fi
