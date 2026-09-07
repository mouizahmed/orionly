# Codex project guidance

- Do not use the in-app browser, computer-use tools, screenshots, or local visual UI inspection unless the user explicitly asks. The user handles visual UI inspection. Code-level checks such as TypeScript, lint, and builds remain appropriate.
- Do not write, add, or modify automated tests. Do not run automated test suites. Verify changes with TypeScript, lint, builds, static checks, and user-led visual inspection instead.

## Local development processes

On macOS/Linux, the four-process local stack is managed by Overmind using `Procfile.dev`; `.overmind.env` selects that Procfile, disables unwanted `PORT` injection, and runs the supervisor as a daemon. Per-process output remains available at these stable paths:

| Process | Overmind name | Log |
| --- | --- | --- |
| Go backend | `backend` | `/tmp/orion-backend.log` |
| Next.js web app | `web` | `/tmp/orion-web.log` |
| Stripe CLI webhook listener | `stripe` | `/tmp/orion-stripe.log` |
| Electron/Vite desktop app | `desktop` | `/tmp/orion-desktop.log` |

When the user asks to start or restart the local development stack, run from the repository root:

```sh
overmind quit 2>/dev/null || true
overmind start
```

The process wrappers gate startup in backend, web, Stripe, desktop order and time out with a clear error when an upstream service never becomes ready.

When only one service needs a restart, keep the rest of the stack alive:

```sh
overmind restart backend
overmind restart web
overmind restart stripe
overmind restart desktop
```

The desktop process wrapper terminates only Orion's exact stale Vite/Electron processes before launch so Electron's single-instance lock cannot make the replacement exit immediately. If Overmind is not already running when the user asks to restart the desktop app, use `overmind start` so all four required processes are launched.

Verify startup without UI inspection:

```sh
overmind status
ps -axo pid,ppid,state,command | rg 'orion/(backend|web)|stripe listen' | rg -v 'rg '
ps -axo pid,ppid,state,command | rg '/Users/admin/Git/orion/desktop/(node_modules/.bin/vite|node_modules/electron)' | rg -v 'rg '
tail -80 /tmp/orion-backend.log
tail -80 /tmp/orion-web.log
tail -80 /tmp/orion-stripe.log
tail -80 /tmp/orion-desktop.log
```

Use `overmind echo` for combined live output, `overmind connect <name>` for an interactive process pane, and `overmind quit` for a graceful full-stack shutdown.
