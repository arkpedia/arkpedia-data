#!/usr/bin/env bash
# Use the image repository's tested official-news selector in the same import that
# confirms dates. Existing repository-scoped keys and fast-forward publication only.
set -euo pipefail
if [ -n "${ARKPEDIA_RELEASE_BRANCH:-}" ] && [ "$ARKPEDIA_RELEASE_BRANCH" != main ]; then
  echo 'Only main publishes Global artwork.'
  exit 0
fi
: "${CATALOGUE_IMAGE_DEPLOY_KEY:?Missing image repository deploy key}"
import_root=$PWD
art_work=$(mktemp -d)
trap 'rm -rf "$art_work"' EXIT
umask 077
printf '%s\n' "$CATALOGUE_IMAGE_DEPLOY_KEY" > "$art_work/image-key"
source "$(dirname "${BASH_SOURCE[0]}")/../content/data-remote.sh"
github_known_hosts "$art_work/known_hosts"
art_ssh="ssh -i $art_work/image-key -o IdentitiesOnly=yes -o UserKnownHostsFile=$art_work/known_hosts -o StrictHostKeyChecking=yes"
art_repo="$art_work/images"
expected=
attempt() {
  rm -rf "$art_repo"
  git clone --quiet --filter=blob:none --no-checkout --depth 1 https://github.com/arkpedia/arkpedia-image-assets.git "$art_repo" || return 75
  git -C "$art_repo" sparse-checkout init --cone && git -C "$art_repo" sparse-checkout set scripts sources .github && git -C "$art_repo" checkout --quiet || return 75
  (cd "$art_repo" && ARKPEDIA_DATA_ROOT="$import_root" python3 scripts/sync_global_banner_art.py --official-only) || return 1
  (cd "$art_repo" && python3 scripts/validate_images.py --staged) || return 1
  if ! git -C "$art_repo" diff --cached --quiet; then
    git -C "$art_repo" -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
      commit --quiet -m 'Adopt Global artwork from confirmed official announcements' || return 1
    GIT_SSH_COMMAND="$art_ssh" git -C "$art_repo" push git@github.com:arkpedia/arkpedia-image-assets.git HEAD:main || return 75
  fi
  expected=$(git -C "$art_repo" rev-parse HEAD)
}
for try in 1 2 3 4; do
  status=0
  attempt || status=$?
  if [ "$status" = 0 ]; then break; fi
  if [ "$status" != 75 ] || [ "$try" = 4 ]; then exit "$status"; fi
  echo "Artwork publication raced another update; retrying from the new head (attempt $try)."
  sleep "$((15 * try))"
done
# Replacements keep their filenames, so existence alone cannot prove adoption.
for try in 1 2 3 4; do
  npm run assets:update
  adopted=$(node -p "require('./data/assets/revisions.json')['arkpedia-image-assets']")
  if [ "$adopted" = "$expected" ]; then
    node scripts/sync/refresh-media-pins.mjs
    exit 0
  fi
  if [ "$try" = 4 ]; then
    echo 'The asset index has not adopted the published Global artwork revision; the stage will retry next import.' >&2
    exit 1
  fi
  sleep "$((15 * try))"
done
