#!/bin/sh
# Runs a runner in the open sandbox, on this machine, next to the Compose
# services that setup.sh started. Jobs run as plain processes with this
# machine's network, toolchain and GPUs, instead of in bare containers.
# README.md's "Sandbox" section says what that gives up.
#
#   sh scripts/open-runner.sh
#
# Set SHERPA_SANDBOX=open in .env first, so the Compose runner stands down
# and only this one claims jobs. It needs Node 26 and git on this machine.
# Stop it with Ctrl-C: the job it holds goes back to the queue.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
die() {
  printf 'open-runner: %s\n' "$*" >&2
  exit 1
}

env=$here/.env
[ -f "$env" ] || die "There's no $env yet. Run sh scripts/setup.sh first."
value() { sed -n "s/^$1=//p" "$env" | tail -n 1; }
[ "$(value SHERPA_SANDBOX)" = open ] || die "Set SHERPA_SANDBOX=open in $env, then run sh scripts/setup.sh, so the Compose runner stands down."
command -v node >/dev/null 2>&1 || die "Node isn't installed. The open runner needs Node 26."
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 26 ? 0 : 1)' || die "The open runner needs Node 26 or later, and this is $(node --version)."
command -v git >/dev/null 2>&1 || die "git isn't installed."

bind=$(value SHERPA_BIND)
case "$bind" in '' | 0.0.0.0) bind=127.0.0.1 ;; esac
port=$(value SHERPA_PORT)
name=$(value SHERPA_RUNNER_NAME)
labels=$(value SHERPA_LABELS)
repos=$(value SHERPA_REPOS)
repos=${repos:-./repos}
case "$repos" in /*) ;; *) repos=$here/$repos ;; esac

# Only the settings the runner reads. env -i keeps every other variable of this shell out of the jobs
exec env -i PATH="$PATH" HOME="$HOME" LANG="${LANG:-C.UTF-8}" \
  SHERPA_SANDBOX=open \
  SHERPA_URL="http://$bind:${port:-8080}" \
  SHERPA_RUNNER_TOKEN="$(value SHERPA_RUNNER_TOKEN)" \
  SHERPA_RUNNER_NAME="${name:-runner-1}-open" \
  SHERPA_LABELS="${labels:-cpu}" \
  SHERPA_REPO="$(value SHERPA_REPO)" \
  SHERPA_REPOS="$repos" \
  SHERPA_WORK="$here/.open-runner" \
  node "$here/src/runner/main.ts"
