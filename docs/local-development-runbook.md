# Orion local development runbook

This runbook starts Orion's four local development processes (API, web, desktop, and Stripe webhook forwarding). Use repository-relative paths so the commands remain portable across checkouts.

## Preferred on macOS/Linux: Overmind

Install the supervisor and tmux once, then manage the stack from the repository root:

```sh
brew install tmux overmind
overmind start
overmind status
overmind echo
overmind quit
```

Overmind supports macOS, Linux, and BSD, but not native Windows. This repository's managed local-development workflow is therefore Unix-only.

The committed `.overmind.env` makes `overmind start` load `Procfile.dev`, disables Overmind's automatic `PORT` values so they cannot override Orion's fixed development ports, and daemonizes the supervisor. The process wrappers gate startup in backend, web app, Stripe listener, and desktop app order. If an upstream process does not become ready within two minutes, its dependents exit with a clear error instead of starting a partial stack. Overmind can restart an individual process without disturbing the rest of the stack:

```sh
overmind restart backend
overmind restart web
overmind restart stripe
overmind restart desktop
```

Combined output is available through `overmind echo`. The process wrappers also append output to `/tmp/orion-backend.log`, `/tmp/orion-web.log`, `/tmp/orion-stripe.log`, and `/tmp/orion-desktop.log`. The Stripe log can contain its development-only signing secret, so do not share it.

## Prerequisites

- Go is installed and available as `go`.
- Node.js/npm are installed. Install each package's dependencies (`npm install` or the repository's documented equivalent) in `web` and `desktop` before the first run.
- Backend dependencies and configuration are present. The API reads `backend/cmd/api/.env` and billing values from `backend/cmd/api/.env.billing` (or the corresponding ignored local files expected by the backend).
- Provider push testing requires a public HTTPS tunnel to the backend. Set
  `CALENDAR_WEBHOOK_BASE_URL` to the tunnel origin and `CALENDAR_PUSH_ENABLED=true`; never use a
  production callback URL against a local process. `CALENDAR_RECONCILIATION_INTERVAL` defaults to five
  minutes and `CALENDAR_FULL_RECONCILIATION_INTERVAL` defaults to `168h`; shorten the latter only in an
  isolated test environment because it clears provider cursors and performs a bounded full scan.
- Stripe CLI is installed and authenticated. Verify authentication without exposing local configuration:

  ```sh
  stripe whoami --format json
  ```

  Do not use commands that print Stripe CLI config or secrets.

## Verify

- API: run `curl --fail http://localhost:8080/api/health` and confirm it returns HTTP `200`.
- Web: open `http://localhost:3000` and confirm the page loads.
- Desktop: confirm Vite reports port `5173` and an Electron window opens.
- Stripe: leave `stripe listen` running and create a test subscription event; confirm the listener reports a forwarded `2xx` response from `localhost:8080`.
- Calendar push: after connecting a provider, confirm active rows exist in
  `integration_webhook_subscriptions`, create/update/delete a meeting in that provider, and verify a
  webhook receipt, a connection-scoped `calendar.sync` job, the normalized Postgres change, and the
  desktop invalidation. Repeat with webhook forwarding stopped to verify periodic recovery within
  `CALENDAR_RECONCILIATION_INTERVAL`.

## Clean shutdown

Run `overmind quit` for a graceful full-stack shutdown. Use `overmind restart <name>` when testing a single process or changing its configuration.

## Troubleshooting

- **Port already in use (8080, 3000, or 5173):** stop the process using that port, then restart the affected process. On macOS/Linux, inspect listeners with `lsof -nP -iTCP:<port> -sTCP:LISTEN`.
- **Webhook signature failures after rotating the listener:** copy the newly printed development signing secret to `backend/cmd/api/.env.billing` as `STRIPE_WEBHOOK_SECRET`, then restart the backend. Do not reuse a stale listener secret.
- **`stripe whoami` fails:** authenticate the Stripe CLI for the current account, then rerun `stripe whoami --format json`; do not print or share the CLI config.
- **Missing modules or packages:** install dependencies in the failing directory and rerun its start command.
- **Calendar push stays disabled:** `CALENDAR_WEBHOOK_BASE_URL` must be an absolute HTTPS URL without a
  query or fragment, and `CALENDAR_PUSH_ENABLED` must be true. Restart the backend after changing either.
- **Google channel does not renew:** check subscription expiration/status/`last_error_code`, provider
  authorization, queue dead letters, and that autonomous connection sync is running. Do not print the
  channel token.
- **Microsoft validation fails:** the public proxy must preserve the decoded `validationToken` query
  and allow the backend to return it as `text/plain` quickly. Do not add user-session middleware to the
  provider webhook routes.

Future agents should use Overmind on macOS/Linux instead of rediscovering the local process setup. Native Windows process management is outside this runbook. Keep this document free of secrets, account IDs, credentials, and process/session IDs.
