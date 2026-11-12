#!/bin/sh
# State of Passkeys – Live Demos: one-line install.
#
#   curl -fsSL https://raw.githubusercontent.com/lonetis/passkeys-demo/main/install.sh | sh
#
# Downloads the compose file into ~/passkeys-demo, pulls the pre-built images and starts
# all demos on http://localhost:8080, reachable from this machine only. Run it again to
# update. Needs curl and Docker with the Compose plugin. Its options are documented in
# .env.example (section "One-line installer").
set -eu

SOURCE_URL="${PASSKEYS_DEMO_SOURCE:-https://raw.githubusercontent.com/lonetis/passkeys-demo/main}"
INSTALL_DIR="${PASSKEYS_DEMO_DIR:-$HOME/passkeys-demo}"
COMPOSE_FILE="$INSTALL_DIR/docker-compose.yml"
ENV_FILE="$INSTALL_DIR/.env"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v docker >/dev/null 2>&1 || fail "Docker is required: https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 \
  || fail "The Docker Compose plugin is required: https://docs.docker.com/compose/install/"
docker info >/dev/null 2>&1 \
  || fail "Cannot reach Docker. Start Docker and try again. If Docker needs sudo on this machine, run the installer with 'sudo sh' instead of 'sh'."

say "Downloading the demo stack into $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
curl -fsSL "$SOURCE_URL/docker-compose.prod.yml" -o "$COMPOSE_FILE"
curl -fsSL "$SOURCE_URL/.env.example" -o "$INSTALL_DIR/.env.example"

if [ -f "$ENV_FILE" ]; then
  echo "Keeping your settings in $ENV_FILE"
else
  # Only this machine can reach the website, so the demos need no password.
  cat > "$ENV_FILE" <<EOF
# Settings of this local install. Every other variable keeps its default;
# see .env.example next to this file for all of them.
APP_BIND=127.0.0.1
APP_PORT=${APP_PORT:-8080}
EOF
fi
PORT="$(sed -n 's/^APP_PORT=//p' "$ENV_FILE" | tail -n 1)"
URL="http://localhost:${PORT:-8080}"

say "Pulling the images (about 1 GB the first time)"
docker compose -f "$COMPOSE_FILE" pull

say "Starting the demos"
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans

printf 'Waiting for %s ' "$URL"
attempts=0
until curl -fsS "$URL/healthz" >/dev/null 2>&1; do
  attempts=$((attempts + 1))
  [ "$attempts" -le 60 ] || fail "The website did not come up. See: docker compose -f \"$COMPOSE_FILE\" logs app"
  printf '.'
  sleep 2
done
echo

cat <<EOF

$(printf '\033[1;32m')State of Passkeys – Live Demos is running: $URL$(printf '\033[0m')
Each demo prepares its two browsers in the background; open one and it is ready within a minute.

Stop:         docker compose -f "$COMPOSE_FILE" down
Start again:  docker compose -f "$COMPOSE_FILE" up -d
Update:       run the install command again
Uninstall:    docker compose -f "$COMPOSE_FILE" down --rmi all && rm -rf "$INSTALL_DIR"
EOF
