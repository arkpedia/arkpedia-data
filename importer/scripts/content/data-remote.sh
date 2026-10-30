# Sourced, never run: what each step that writes to arkpedia-data over SSH needs (both content
# channels' publish steps and the heartbeat in prepare-content.yml), and GitHub's host keys for
# the art publisher (scripts/sync/publish-catalogue-assets.sh). The deploy-key, known_hosts and
# GIT_SSH_COMMAND block used to be pasted into each step, with the pointer push a copy of the
# heartbeat's.
#
#   github_known_hosts <file>    GitHub's published SSH host keys, fetched over authenticated
#                                HTTPS (api.github.com/meta), as a known_hosts file
#   with_data_key                CONTENT_DATA_DEPLOY_KEY and GitHub's host keys, in a private
#                                folder under RUNNER_TEMP that the shell's EXIT trap removes (it
#                                replaces any trap the step set), and GIT_SSH_COMMAND exported to
#                                use them. A known_hosts file of its own: the self-hosted runner
#                                keeps its home between jobs, and each step overwrote the runner's
#                                ~/.ssh/known_hosts.
#   push_file_to_branch <branch> <file> <message>
#                                <file>, under its own name, committed on top of <branch>'s last
#                                commit in arkpedia-data (the first one starts the branch) and
#                                pushed; nothing when the branch holds those bytes already. For
#                                the branches that hold one small file: a channel's pointer
#                                (current.json), the heartbeat. Never forced: a push that lost a
#                                race is refused.
DATA_REMOTE=git@github.com:arkpedia/arkpedia-data.git

github_known_hosts() {
  curl --fail --silent --show-error https://api.github.com/meta \
    | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{for(const key of JSON.parse(s).ssh_keys)console.log("github.com "+key)})' > "$1"
}

with_data_key() {
  : "${CONTENT_DATA_DEPLOY_KEY:?CONTENT_DATA_DEPLOY_KEY is not set}"
  DATA_REMOTE_DIR=$(mktemp -d "${RUNNER_TEMP:-/tmp}/data-remote.XXXXXX")
  trap 'rm -rf "$DATA_REMOTE_DIR"' EXIT
  (umask 077 && printf '%s\n' "$CONTENT_DATA_DEPLOY_KEY" > "$DATA_REMOTE_DIR/key")
  github_known_hosts "$DATA_REMOTE_DIR/known_hosts"
  export GIT_SSH_COMMAND="ssh -i $DATA_REMOTE_DIR/key -o IdentitiesOnly=yes -o UserKnownHostsFile=$DATA_REMOTE_DIR/known_hosts -o StrictHostKeyChecking=yes"
}

push_file_to_branch() {
  local branch=$1 file=$2 message=$3 name at
  name=$(basename "$file")
  at=$(mktemp -d "${RUNNER_TEMP:-/tmp}/branch.XXXXXX")
  git init --quiet "$at"
  git -C "$at" remote add origin "$DATA_REMOTE"
  if git -C "$at" fetch --quiet --depth 1 origin "$branch"; then
    git -C "$at" checkout --quiet -B "$branch" FETCH_HEAD
  else
    git -C "$at" checkout --quiet --orphan "$branch"
  fi
  cp "$file" "$at/$name"
  git -C "$at" add "$name"
  if ! git -C "$at" diff --cached --quiet; then
    git -C "$at" -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
      commit --quiet -m "$message"
    git -C "$at" push --quiet origin "HEAD:$branch"
  fi
  rm -rf "$at"
}
