# nomi-notifier

A small, read-only bridge that forwards every message your Nomi sends to a
webhook, in real time, proactive and scheduled messages included. Point it at
any URL and build whatever reacts on the other end: a phone notification, a
home-automation trigger, a wearable that buzzes and shows the message. With no
webhook configured it simply prints each message to its log, so you can watch
it work before wiring anything up.

It only observes. It never sends a message on your behalf and never spends
credits. It uses your own Nomi session, the same way the website does.

## What you get

For each message a Nomi sends, one `POST` with a JSON body (or, in console
mode, one printed line):

```json
{
  "nomiId": 2102243547,
  "nomiName": "Linda",
  "uuid": "6aa5c4c0-039d-c36d-99e5-135300000000",
  "text": "the full message text",
  "proactive": false,
  "isVoiceMessage": false,
  "sent": "2026-09-12T21:31:44.138Z"
}
```

`proactive` is `true` when the Nomi started the exchange on its own (a
proactive or scheduled message) and `false` when it is replying to you. Each
message is delivered exactly once, with its finalized text.

## Quick start

You need Docker (with Compose). All three options use the same public,
multi-arch image (amd64 and arm64, so a Raspberry Pi works too). Pick the
shortest one for you.

### 1. One command

```bash
curl -fsSL https://nomi.zar.mx/notifier.sh | sh
```

It asks for your session cookie (hidden input, never on the command line),
optionally a webhook URL (press Enter to skip and just print messages), writes
a `docker-compose.yml` and `.env` into `~/nomi-notifier`, and starts it. The
script is `install.sh` in this repository, read it first if you like.

### 2. Plain `docker run`

```bash
docker run -d --name nomi-notifier --restart unless-stopped \
  -e NOMI_SESSION_TOKEN=your-cookie-value \
  ghcr.io/thedackss/nomi-notifier:latest
```

That runs in console mode. Add `-e NOMI_WEBHOOK_URL=https://...` to forward
to a webhook instead. `docker logs -f nomi-notifier` shows it working.

### 3. Compose file

`docker-compose.yml`:

```yaml
services:
  nomi-notifier:
    image: ghcr.io/thedackss/nomi-notifier:latest
    env_file: .env
    restart: unless-stopped
```

`.env` next to it (only the token is required):

```
NOMI_SESSION_TOKEN=your-cookie-value
NOMI_WEBHOOK_URL=https://your-webhook-endpoint
```

Then `docker compose up -d` and `docker compose logs -f`.

In every case the container restarts on its own and reconnects if the
connection drops. No secrets are baked into the image; they come from your
environment at run time.

## Run from source

With Docker (builds the image locally):

```bash
git clone https://github.com/thedackss/nomi-notifier.git && cd nomi-notifier
cp .env.example .env      # then fill in the token
docker compose up -d
```

With Node.js 20.6 or newer (it uses the built-in `--env-file`):

```bash
npm install
npm run build
cp .env.example .env      # then fill in the token
npm start
```

## Configuration

Everything is set in the environment (see `.env.example`):

| Variable | Required | What it does |
| --- | --- | --- |
| `NOMI_SESSION_TOKEN` | yes | Your `__Secure-next-auth.session-token` cookie from a logged-in beta.nomi.ai browser session. |
| `NOMI_WEBHOOK_URL` | no | The URL that receives the POST for each message. Unset = console mode: each message is printed to the log instead. |
| `NOMI_NOMI_IDS` | no | Comma-separated Nomi ids to forward. Default: all of your Nomis. |
| `NOMI_PROACTIVE_ONLY` | no | Set to `1` to forward only proactive/scheduled messages, not replies. |
| `NOMI_DEBOUNCE_MS` | no | How long to wait for a message's finalized text (default `1500`). |

To find a Nomi's id, open it on the website: the number in the URL
(`beta.nomi.ai/nomis/<id>`) is the id.

## Getting the session cookie

1. Log in to beta.nomi.ai in your browser.
2. Open the developer tools, go to the Application (Chrome) or Storage
   (Firefox) tab, then Cookies for `beta.nomi.ai`.
3. Copy the value of `__Secure-next-auth.session-token`.

The cookie expires periodically. When the log shows connection or auth errors,
put a fresh one in `.env` and restart (`docker compose restart`, or rerun the
one-line installer).

## How it works

The Nomi website receives messages over a Socket.IO connection
(`wss://beta.nomi.ai/socket/`), authenticated by the session cookie. This
program opens that same connection and watches the `NomiChatEvent` stream. A
message arrives first as a streaming partial and then in its finalized form,
so the notifier waits briefly (`NOMI_DEBOUNCE_MS`) and forwards it once with
the final text. Everything runs in a single file, `src/index.ts`, with the
event shapes typed inline.

## Privacy and safety

- Read-only: no messages are sent, no settings changed, no credits used.
- Your cookie and messages only travel between your machine, beta.nomi.ai,
  and the webhook URL you configure (if any). Nothing else is contacted.
- Keep `.env` private; it is gitignored, excluded from the Docker image, and
  the installer creates it with owner-only permissions.

## License

MIT. See `LICENSE`.
