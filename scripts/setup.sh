#!/bin/sh
# Sets up Sherpa on this machine and starts it. The first time, it
# writes .env with three fresh tokens. Every time, it makes the folder for
# bare repos, builds and starts both services with Docker Compose, and says
# where the dashboard is and how to sign in.
#
# Run it from anywhere: sh scripts/setup.sh
# It's safe to run again, such as after a git pull to upgrade: it keeps .env,
# the database and the repos, and rebuilds the images.
set -eu
cd "$(dirname "$0")/.."

die() {
  printf 'setup: %s\n' "$*" >&2
  exit 1
}
# The last value .env gives a setting, or empty
value() { sed -n "s/^$1=//p" .env | tail -n 1; }
token() { openssl rand -hex 24 2>/dev/null || od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; }

command -v docker >/dev/null 2>&1 || die "Docker isn't installed. Install Docker Engine with the Compose plugin: https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "Docker Compose isn't installed. Install the Compose plugin: https://docs.docker.com/compose/install/linux/"
docker info >/dev/null 2>&1 || die "Docker is installed, but this user can't reach the Docker daemon. Start Docker, or add yourself to the docker group and log in again."

if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  echo "Wrote .env with three new tokens."
fi
for role in AGENT RUNNER ADMIN; do
  if grep -q "^SHERPA_${role}_TOKEN=$" .env; then
    sed -i.bak "s/^SHERPA_${role}_TOKEN=$/SHERPA_${role}_TOKEN=$(token)/" .env
    rm -f .env.bak
  fi
done

# Docker would make a missing folder itself, owned by root, and then you couldn't add repos to it
repos=$(value SHERPA_REPOS)
mkdir -p "${repos:-./repos}"

echo "Building and starting sherpa-server and sherpa-runner…"
docker compose up -d --build --wait || die "Docker Compose couldn't start the services. If the port is taken, set SHERPA_PORT in .env. The logs: docker compose logs"

port=$(value SHERPA_PORT)
bind=$(value SHERPA_BIND)
case "$bind" in '' | 0.0.0.0) bind=127.0.0.1 ;; esac
cat <<EOF

Sherpa is running.

  Dashboard     http://$bind:${port:-8080}
  Admin token   $(value SHERPA_ADMIN_TOKEN)

The dashboard asks for the admin token. It's SHERPA_ADMIN_TOKEN in $(pwd)/.env.

Next, connect the checkout an agent will work in, giving the agent an ID:

  sh scripts/connect.sh ~/code/my-project 1
EOF
