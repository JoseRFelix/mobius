# Mobius

Mobius is an OpenTUI prediction-market terminal backed by one shared market-data
gateway. It displays Polymarket and Kalshi as provider-qualified, independent
rows—similar contracts are never merged or aggregated.

The same OpenTUI application runs natively or streams into the browser through
xterm.js. Polymarket uses its public REST and market WebSocket feeds. Kalshi
uses public REST polling by default and upgrades to its authenticated WebSocket
when API credentials are configured.

## Architecture

```text
Polymarket REST/WS ─┐
                    ├─ Bun market gateway ─┬─ OpenTUI browser sessions
Kalshi REST/WS ─────┘                      ├─ /market-data WebSocket clients
                                           └─ /markets HTTP snapshots

Browser watchlist: IndexedDB     Native watchlist: local SQLite
```

The gateway maintains one provider connection and in-memory cache for all
clients, broadcasts snapshots and deltas, reports provider health, and handles
reconnects. Personal watchlists remain device-local.

## Requirements

- Node.js 22.13 or newer
- Bun 1.3 or newer

## Run the browser version

Install dependencies, then run the web shell and gateway in separate terminals:

```bash
npm install
npm run dev
```

```bash
npm run tui:web
```

Open `http://localhost:3000`. Copy `.env.example` to `.env.local` if you need
non-default ports, a hosted gateway, or Kalshi WebSocket credentials.

## Run the native terminal

```bash
npm run tui
```

Its watchlist is stored in `.mobius/watchlist.sqlite` by default.

## Controls

- `↑` / `k` and `↓` / `j`: select a provider market row
- `w`: add or remove the selected market from the local watchlist
- `f`: show all rows or watchlist rows only
- `1`, `2`, `3`: switch between 1H, 24H, and 7D chart ranges
- `p` or `space`: pause or resume screen updates
- `q`: close the terminal session

## Gateway endpoints

- `GET /health` — provider states and cached market count
- `GET /markets` — current normalized snapshot
- `WS /market-data` — snapshots plus `market.upsert`, `market.remove`, and
  `provider.status` events
- `WS /terminal` — OpenTUI terminal stream and per-session watchlist sync

Market keys always include their source, such as `kalshi:RAIN-NYC` or
`polymarket:<condition-id>:<yes-token-id>`.

## Project structure

- `market-data/` — protocol, cache/fan-out hub, and provider adapters
- `watchlist/` — shared schema, IndexedDB adapter, and SQLite adapter
- `tui/app.ts` — live OpenTUI layout and keyboard interactions
- `tui/server.ts` — Bun BFF, WebSockets, HTTP snapshots, and terminal bridge
- `app/terminal-dashboard.tsx` — xterm.js browser client and IndexedDB sync

## Validation

```bash
npm test
npx tsc --noEmit
npm run lint
```

The hosted browser shell still needs `NEXT_PUBLIC_TUI_BRIDGE_HOST` set to an
always-on deployment of `tui/server.ts`; the Sites worker is not a persistent
Bun WebSocket process.
