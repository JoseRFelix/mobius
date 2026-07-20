import { PassThrough, Writable } from "node:stream";
import { getMarketDataHub, type MarketDataEvent } from "../market-data/hub";
import {
  encodeMarketDataMessage,
  marketDataClientMessageSchema,
} from "../market-data/protocol";
import type { MarketKey } from "../market-data/types";
import { normalizeWatchlist, watchlistItemsSchema, type WatchlistItem } from "../watchlist/types";
import { createMarketDashboard } from "./app";

class SocketWriteStream extends Writable {
  readonly isTTY = true;
  columns: number;
  rows: number;

  constructor(
    columns: number,
    rows: number,
    private readonly emitOutput: (value: string) => void,
  ) {
    super();
    this.columns = columns;
    this.rows = rows;
  }

  _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.emitOutput(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    callback();
  }

  getColorDepth() {
    return 24;
  }

  hasColors() {
    return true;
  }
}

type SocketSession = Awaited<ReturnType<typeof createMarketDashboard>>;

type SocketData = {
  kind: "terminal" | "market-data";
  session: SocketSession | null;
  input: PassThrough | null;
  output: SocketWriteStream | null;
  cols: number;
  rows: number;
  closed: boolean;
  watchlist: WatchlistItem[];
  marketKeys: Set<MarketKey> | null;
  unsubscribeHub: (() => void) | null;
};

const port = Number(process.env.TUI_BRIDGE_PORT ?? 3001);
const hub = getMarketDataHub();
void hub.start();

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": process.env.CORS_ORIGIN ?? "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
  };
}

function filteredEvent(event: MarketDataEvent, keys: Set<MarketKey> | null): MarketDataEvent | null {
  if (!keys) return event;
  if (event.type === "market.upsert" && !keys.has(event.market.key)) return null;
  if (event.type === "market.remove" && !keys.has(event.key)) return null;
  if (event.type === "snapshot") {
    return { ...event, markets: event.markets.filter((market) => keys.has(market.key)) };
  }
  return event;
}

const server = Bun.serve<SocketData>({
  port,
  fetch(request, server) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

    if (url.pathname === "/health") {
      return Response.json(
        {
          ok: true,
          service: "mobius-market-gateway",
          marketCount: hub.getMarkets().length,
          providers: hub.getProviderStatuses(),
        },
        { headers: corsHeaders() },
      );
    }

    if (url.pathname === "/markets") {
      return Response.json(hub.snapshot(), { headers: corsHeaders() });
    }

    if (url.pathname !== "/terminal" && url.pathname !== "/market-data") {
      return new Response("Mobius market-data gateway", { status: 200, headers: corsHeaders() });
    }

    const kind = url.pathname === "/terminal" ? "terminal" : "market-data";
    const cols = Math.max(40, Number(url.searchParams.get("cols") ?? 120));
    const rows = Math.max(22, Number(url.searchParams.get("rows") ?? 40));
    const upgraded = server.upgrade(request, {
      data: {
        kind,
        session: null,
        input: null,
        output: null,
        cols,
        rows,
        closed: false,
        watchlist: [],
        marketKeys: null,
        unsubscribeHub: null,
      },
    });

    return upgraded ? undefined : new Response("WebSocket upgrade required", { status: 426 });
  },
  websocket: {
    async open(socket) {
      if (socket.data.kind === "market-data") {
        socket.data.unsubscribeHub = hub.subscribe((event) => {
          const filtered = filteredEvent(event, socket.data.marketKeys);
          if (filtered && !socket.data.closed) socket.send(encodeMarketDataMessage(filtered));
        });
        return;
      }

      const input = new PassThrough();
      Object.assign(input, {
        isTTY: true,
        isRaw: true,
        setRawMode: () => input,
      });

      const output = new SocketWriteStream(socket.data.cols, socket.data.rows, (value) => {
        if (!socket.data.closed) socket.send(JSON.stringify({ type: "output", data: value }));
      });
      socket.data.input = input;
      socket.data.output = output;

      try {
        const session = await createMarketDashboard({
          stdin: input as unknown as NodeJS.ReadStream,
          stdout: output as unknown as NodeJS.WriteStream,
          width: socket.data.cols,
          height: socket.data.rows,
          remote: true,
          marketHub: hub,
          watchlist: socket.data.watchlist,
          onWatchlistChange: (items) => {
            socket.data.watchlist = items;
            if (!socket.data.closed) socket.send(JSON.stringify({ type: "watchlist.persist", items }));
          },
          onQuit: () => socket.close(1000, "Dashboard closed"),
        });
        socket.data.session = session;
        session.setWatchlist(socket.data.watchlist);
        if (socket.data.closed) session.dispose();
      } catch (error) {
        socket.send(
          JSON.stringify({
            type: "error",
            message: error instanceof Error ? error.message : "Unable to start OpenTUI",
          }),
        );
        socket.close(1011, "OpenTUI failed to start");
      }
    },
    message(socket, message) {
      if (typeof message !== "string") return;

      try {
        const raw = JSON.parse(message) as unknown;
        if (socket.data.kind === "market-data") {
          const payload = marketDataClientMessageSchema.parse(raw);
          if (payload.type === "subscribe") {
            socket.data.marketKeys = new Set(payload.keys as MarketKey[]);
            const snapshot = filteredEvent(hub.snapshot(), socket.data.marketKeys);
            if (snapshot) socket.send(encodeMarketDataMessage(snapshot));
          } else if (payload.type === "unsubscribe" && socket.data.marketKeys) {
            for (const key of payload.keys) socket.data.marketKeys.delete(key as MarketKey);
          } else if (payload.type === "snapshot.get") {
            const snapshot = filteredEvent(hub.snapshot(), socket.data.marketKeys);
            if (snapshot) socket.send(encodeMarketDataMessage(snapshot));
          }
          return;
        }

        const payload = raw as
          | { type: "input"; data: string }
          | { type: "resize"; cols: number; rows: number }
          | { type: "watchlist.sync"; items: unknown };

        if (payload.type === "input") {
          socket.data.input?.write(payload.data);
        } else if (payload.type === "resize") {
          const cols = Math.max(40, Math.floor(payload.cols));
          const rows = Math.max(22, Math.floor(payload.rows));
          socket.data.cols = cols;
          socket.data.rows = rows;
          if (socket.data.output) {
            socket.data.output.columns = cols;
            socket.data.output.rows = rows;
          }
          socket.data.session?.resize(cols, rows);
        } else if (payload.type === "watchlist.sync") {
          socket.data.watchlist = normalizeWatchlist(watchlistItemsSchema.parse(payload.items));
          socket.data.session?.setWatchlist(socket.data.watchlist);
          socket.send(JSON.stringify({ type: "watchlist.ack", count: socket.data.watchlist.length }));
        }
      } catch (error) {
        socket.send(
          JSON.stringify({
            type: "error",
            message: error instanceof Error ? error.message : "Malformed client message",
          }),
        );
      }
    },
    close(socket) {
      socket.data.closed = true;
      socket.data.unsubscribeHub?.();
      socket.data.session?.dispose();
      socket.data.input?.end();
      socket.data.output?.end();
    },
  },
});

function shutdown(): void {
  hub.stop();
  server.stop(true);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(`Mobius gateway listening on http://localhost:${server.port}`);
console.log(`  terminal: ws://localhost:${server.port}/terminal`);
console.log(`  data:     ws://localhost:${server.port}/market-data`);
