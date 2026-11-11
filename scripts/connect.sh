#!/bin/sh
# Connects the checkout an agent works in to Sherpa. Run it after
# setup.sh, from anywhere:
#
#   sh scripts/connect.sh <checkout> <agent id> [--url <sherpa-server address>]
#
# It copies the repo into repos/ as a bare repo, which the runner fetches
# commits from, and adds that to the checkout as the remote `sherpa`. Then it
# writes into the checkout:
#   .sherpa/env                     the agent's settings, its token included
#   .sherpa/hook.sh                 the hook that shows the agent its board line
#   .sherpa/guide.md                the agent's instructions
#   .claude/settings.local.json   the Claude Code hooks, unless it exists
#   .codex/hooks.json             the Codex hooks, unless it exists
# Git ignores what it writes, through the repo's info/exclude, so the token
# never lands in a commit. Run it again after an upgrade to refresh .sherpa/.
set -eu
sherpa=$(cd "$(dirname "$0")/.." && pwd)

die() {
  printf 'connect: %s\n' "$*" >&2
  exit 1
}
usage() { die 'usage: sh scripts/connect.sh <checkout> <agent id> [--url <sherpa-server address>]'; }

checkout='' id='' url=''
while [ $# -gt 0 ]; do
  case "$1" in
    --url)
      [ $# -ge 2 ] || usage
      url=$2
      shift 2
      ;;
    -h | --help)
      sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) usage ;;
    *)
      if [ -z "$checkout" ]; then checkout=$1; elif [ -z "$id" ]; then id=$1; else usage; fi
      shift
      ;;
  esac
done
[ -n "$checkout" ] && [ -n "$id" ] || usage
printf '%s' "$id" | grep -Eq '^[A-Za-z0-9_-]{1,40}$' || die 'An agent ID is 1 to 40 letters, digits, - or _, such as 1 or search-a.'

env=$sherpa/.env
[ -f "$env" ] || die "There's no $env yet. Run sh scripts/setup.sh first."
value() { sed -n "s/^$1=//p" "$env" | tail -n 1; }
token=$(value SHERPA_AGENT_TOKEN)
[ -n "$token" ] || die "SHERPA_AGENT_TOKEN is empty in $env. Run sh scripts/setup.sh first."
if [ -z "$url" ]; then
  bind=$(value SHERPA_BIND)
  port=$(value SHERPA_PORT)
  case "$bind" in '' | 0.0.0.0) bind=127.0.0.1 ;; esac
  url=http://$bind:${port:-8080}
fi
url=${url%/}

top=$(git -C "$checkout" rev-parse --show-toplevel 2>/dev/null) || die "$checkout isn't a git checkout."
start=$(git -C "$top" rev-parse --verify -q HEAD) || die "$top has no commits yet. Commit the code the agent starts from, then run this again."

# One bare repo per repo, named after it, shared by every agent and worktree that works on it
common=$(git -C "$top" rev-parse --path-format=absolute --git-common-dir)
case "$common" in
  */.git) name=$(basename "$(dirname "$common")") ;;
  *) name=$(basename "$common" .git) ;;
esac
name=$(printf '%s' "$name" | tr -c 'A-Za-z0-9._-' '-')
repos=$(value SHERPA_REPOS)
repos=${repos:-./repos}
case "$repos" in /*) ;; *) repos=$sherpa/$repos ;; esac
mkdir -p "$repos"
repos=$(cd "$repos" && pwd)
[ -w "$repos" ] || die "$repos isn't writable, likely because Docker made it as root. Run: sudo chown $(id -un) $repos"
bare=$repos/$name.git
if [ ! -d "$bare" ]; then
  git clone -q --bare "$top" "$bare"
  echo "Made the bare repo $bare."
fi
have=$(git -C "$top" remote get-url sherpa 2>/dev/null || true)
if [ -z "$have" ]; then
  git -C "$top" remote add sherpa "$bare"
elif [ "$have" != "$bare" ]; then
  die "The checkout already has a remote named sherpa, at $have. Remove it with: git -C $top remote remove sherpa"
fi
# A ref named after the commit keeps it fetchable, whatever happens to the branches
git -C "$top" push -q sherpa "HEAD:refs/sherpa/$start"

dir=$top/.sherpa
mkdir -p "$dir"
cat >"$dir/env" <<EOF
# Sherpa settings for agent $id, written by scripts/connect.sh.
# Load them into a shell with: . .sherpa/env
# Git ignores this folder, because this file holds the agent token.
SHERPA_URL=$url
SHERPA_AGENT_ID=$id
SHERPA_AGENT_TOKEN=$token
# The short names the guide's examples use. REPO is the remote the runner
# fetches commits from: give it as the project's "repo".
W=\$SHERPA_URL
ID=\$SHERPA_AGENT_ID
AUTH="Authorization: Bearer \$SHERPA_AGENT_TOKEN"
REPO=file:///repos/$name.git
export SHERPA_URL SHERPA_AGENT_ID SHERPA_AGENT_TOKEN W ID AUTH REPO
EOF
chmod 600 "$dir/env"
cp "$sherpa/scripts/sherpa-hook.sh" "$dir/hook.sh"
cp "$sherpa/docs/agent-guide.md" "$dir/guide.md"

exclude=$(git -C "$top" rev-parse --path-format=absolute --git-path info/exclude)
mkdir -p "$(dirname "$exclude")"
ignore() { grep -qxF "$1" "$exclude" 2>/dev/null || printf '%s\n' "$1" >>"$exclude"; }
ignore /.sherpa/

row() { printf '  %-29s %s\n' "$1" "$2"; }
# Hooks: written only where no such file exists, since this script can't merge JSON
hooks() { # <file> <tool> <json>
  if [ ! -f "$top/$1" ]; then
    mkdir -p "$(dirname "$top/$1")"
    printf '%s\n' "$3" >"$top/$1"
    ignore "/$1"
    row "$1" "the $2 hooks"
  elif grep -q '.sherpa/hook.sh' "$top/$1"; then
    row "$1" "the $2 hooks, already there"
  else
    row "$1" "already exists, so add the $2 hooks from README.md to it yourself"
  fi
}

echo
echo "Connected $top for agent $id."
echo
row 'remote sherpa' "$bare, which the runner fetches as file:///repos/$name.git"
row .sherpa/ 'env, hook.sh and guide.md'
hooks .claude/settings.local.json 'Claude Code' '{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "sh \"$CLAUDE_PROJECT_DIR/.sherpa/hook.sh\"" }] }],
    "PostToolBatch": [{ "hooks": [{ "type": "command", "command": "sh \"$CLAUDE_PROJECT_DIR/.sherpa/hook.sh\" PostToolBatch" }] }]
  }
}'
hooks .codex/hooks.json Codex '{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "sh .sherpa/hook.sh" }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "sh .sherpa/hook.sh PostToolUse" }] }]
  }
}'
echo
echo "Git ignores all of it. The hook says:"
echo
printf '  %s\n' "$(sh "$dir/hook.sh")"
echo
echo "Start the agent in $top with a prompt like this one, with your goal in it:"
echo
echo "  You're agent $id on Sherpa. Read .sherpa/guide.md and follow it. Your goal: <the metric and the value to reach, such as p95 latency under 250 ms>, within <N> hours. Plan the climb as a project with that as its goal, starting from commit $start, with repo file:///repos/$name.git."
echo
echo "Then start a second session, the verifier, in a folder of its own, to write each module's tests and benchmark:"
echo
echo "  You write the verifiers for agent $id on Sherpa. Load the settings with . $dir/env and read $dir/guide.md, the part \"If you write the verifiers\" above all. Every few minutes, list the modules with curl -sS \"\$W/agents/\$ID/project\" -H \"\$AUTH\", freeze verifiers for each one whose \"verifiers\" is \"missing\", and file a change request for each one whose \"verifiers\" is \"failed\", until the project ends."
