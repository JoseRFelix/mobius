# Mobius

Mobius is an initial OpenTUI prediction-market dashboard. It shows a market
screener, live probability chart, order book, and recent trades using a
simulated data feed. The same OpenTUI application can run directly in a terminal
or stream into the included browser shell through WebSockets.

## Requirements

- Node.js 22.13 or newer
- Bun 1.3 or newer

## Browser version

Install dependencies, then run the web shell and OpenTUI bridge in separate
terminals:

```bash
npm install
npm run dev
```

```bash
npm run tui:web
```

Open `http://localhost:3000`.

## Native terminal version

```bash
npm run tui
```

## Controls

- `↑` / `k` and `↓` / `j`: select a market
- `1`, `2`, `3`: switch between 1H, 24H, and 7D chart ranges
- `p` or `space`: pause/resume the simulated feed
- `q`: close the terminal session

## Project structure

- `tui/app.ts` — OpenTUI layout, updates, and keyboard interactions
- `tui/chart.ts` — dependency-free Braille line chart renderer
- `tui/markets.ts` — replaceable simulated market-data adapter
- `tui/server.ts` — Bun WebSocket-to-OpenTUI stream bridge
- `app/terminal-dashboard.tsx` — xterm.js browser client

## Validation

```bash
npm run build
npx tsc --noEmit
npm run lint
```

The browser bridge is currently intended for local development. A hosted
version needs a persistent Bun or Node service alongside the static web shell.
