#!/bin/sh
# nomi-notifier one-line installer.
#
#   curl -fsSL https://nomi.zar.mx/notifier.sh | sh
#
# Sets up the public Docker image with a docker-compose.yml and a .env in
# ~/nomi-notifier (override with NOMI_NOTIFIER_DIR), then starts it.
#
# The session cookie is never taken as a command-line argument: that would
# leave it in your shell history and visible to other processes. The script
# prompts for it with hidden input, or uses NOMI_SESSION_TOKEN if it is
# already set in the environment. Same for NOMI_WEBHOOK_URL (optional).
set -eu

IMAGE="ghcr.io/thedackss/nomi-notifier:latest"
DIR="${NOMI_NOTIFIER_DIR:-$HOME/nomi-notifier}"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 \
    || die "Docker is not installed. See https://docs.docker.com/get-docker/ and rerun."
docker compose version >/dev/null 2>&1 \
    || die "Docker Compose v2 is not available. Install the docker-compose-plugin and rerun."

# When this script is piped from curl, stdin is the script itself, so any
# prompting must go through the terminal directly.
TTY=/dev/tty
[ -r "$TTY" ] && [ -w "$TTY" ] || TTY=""

# Print $1 as a prompt, read one line from the terminal with echo off.
prompt_hidden() {
    [ -n "$TTY" ] || die "no terminal to prompt on; set NOMI_SESSION_TOKEN in the environment instead."
    printf '%s' "$1" > "$TTY"
    stty -echo < "$TTY"
    IFS= read -r value < "$TTY" || value=""
    stty echo < "$TTY"
    printf '\n' > "$TTY"
    printf '%s' "$value"
}

# Print $1 as a prompt, read one line from the terminal (visible).
prompt() {
    [ -n "$TTY" ] || { printf ''; return 0; }
    printf '%s' "$1" > "$TTY"
    IFS= read -r value < "$TTY" || value=""
    printf '%s' "$value"
}

say "nomi-notifier setup"
say "Forwards your Nomi's incoming messages to a webhook, or prints them if you skip the webhook."
say ""

TOKEN="${NOMI_SESSION_TOKEN:-}"
if [ -z "$TOKEN" ]; then
    say "Paste your beta.nomi.ai session cookie (the __Secure-next-auth.session-token value)."
    say "Input is hidden."
    TOKEN=$(prompt_hidden "Session token: ")
fi
[ -n "$TOKEN" ] || die "a session token is required."

WEBHOOK="${NOMI_WEBHOOK_URL:-}"
if [ -z "$WEBHOOK" ]; then
    WEBHOOK=$(prompt "Webhook URL (press Enter to skip and just print messages): ")
fi

mkdir -p "$DIR"
umask 077
{
    printf 'NOMI_SESSION_TOKEN=%s\n' "$TOKEN"
    if [ -n "$WEBHOOK" ]; then
        printf 'NOMI_WEBHOOK_URL=%s\n' "$WEBHOOK"
    fi
} > "$DIR/.env"
chmod 600 "$DIR/.env"

cat > "$DIR/docker-compose.yml" <<EOF
services:
  nomi-notifier:
    image: $IMAGE
    env_file: .env
    restart: unless-stopped
EOF

say ""
say "Starting in $DIR ..."
(cd "$DIR" && docker compose pull -q && docker compose up -d)
say ""
say "Running. From $DIR:"
say "  docker compose logs -f     watch messages and the connection"
say "  docker compose restart     after editing .env (for example a fresh cookie)"
say "  docker compose down        stop"
