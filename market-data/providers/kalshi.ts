import { readFileSync } from "node:fs";
import { constants, createSign } from "node:crypto";
import { z } from "zod";
import { DEFAULT_MARKET_PAGE_SIZE, MAX_MARKET_PAGE_SIZE } from "../config";
import { logger } from "../logger";
import { providerStatus, type MarketProvider, type ProviderCallbacks } from "../provider";
import { asCents, asNumber, marketKey, type MarketRecord, type OrderLevel } from "../types";

const REST_BASE_URL = "https://external-api.kalshi.com/trade-api/v2";
const SOCKET_URL = "wss://external-api-ws.kalshi.com/trade-api/ws/v2";
const SOCKET_PATH = "/trade-api/ws/v2";

const kalshiMarketSchema = z
  .object({
    ticker: z.string(),
    event_ticker: z.string().optional(),
    title: z.string(),
    status: z.string(),
    close_time: z.string().optional(),
    yes_bid_dollars: z.union([z.string(), z.number()]).optional(),
    yes_bid_size_fp: z.union([z.string(), z.number()]).optional(),
    yes_ask_dollars: z.union([z.string(), z.number()]).optional(),
    yes_ask_size_fp: z.union([z.string(), z.number()]).optional(),
    last_price_dollars: z.union([z.string(), z.number()]).optional(),
    previous_price_dollars: z.union([z.string(), z.number()]).optional(),
    volume_fp: z.union([z.string(), z.number()]).optional(),
    volume_24h_fp: z.union([z.string(), z.number()]).optional(),
    open_interest_fp: z.union([z.string(), z.number()]).optional(),
    liquidity_dollars: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

const kalshiMarketsResponseSchema = z.object({
  markets: z.array(kalshiMarketSchema),
  cursor: z.string().optional(),
});

const candlestickSchema = z
  .object({
    end_period_ts: z.number(),
    price: z
      .object({
        close_dollars: z.union([z.string(), z.number()]).nullable().optional(),
        previous_dollars: z.union([z.string(), z.number()]).nullable().optional(),
        close: z.union([z.string(), z.number()]).nullable().optional(),
        previous: z.union([z.string(), z.number()]).nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const batchCandlesticksSchema = z.object({
  markets: z.array(
    z.object({
      market_ticker: z.string(),
      candlesticks: z.array(candlestickSchema),
    }),
  ),
});

type KalshiMarket = z.infer<typeof kalshiMarketSchema>;

function historyOrFallback(history: number[], value: number): number[] {
  if (history.length > 0) return history.slice(-360);
  return Array.from({ length: 24 }, () => value);
}

export function normalizeKalshiMarket(raw: KalshiMarket, history: number[] = []): MarketRecord {
  const yesBid = raw.yes_bid_dollars == null ? undefined : asCents(raw.yes_bid_dollars);
  const yesAsk = raw.yes_ask_dollars == null ? undefined : asCents(raw.yes_ask_dollars);
  const last = asCents(raw.last_price_dollars, 0);
  const midpoint =
    yesBid != null && yesAsk != null && yesAsk >= yesBid ? (yesBid + yesAsk) / 2 : last || 50;
  const values = historyOrFallback(history, midpoint);
  const bidSize = asNumber(raw.yes_bid_size_fp);
  const askSize = asNumber(raw.yes_ask_size_fp);

  return {
    key: marketKey("kalshi", raw.ticker),
    source: "kalshi",
    marketId: raw.ticker,
    category: "KALSHI",
    question: raw.title,
    yes: midpoint,
    yesBid,
    yesAsk,
    change: midpoint - values[0],
    volume: asNumber(raw.volume_24h_fp ?? raw.volume_fp),
    liquidity: asNumber(raw.liquidity_dollars ?? raw.open_interest_fp),
    history: values,
    bids: yesBid == null ? [] : [{ price: yesBid, size: bidSize }],
    asks: yesAsk == null ? [] : [{ price: yesAsk, size: askSize }],
    trades: [],
    status: raw.status,
    url: raw.event_ticker
      ? `https://kalshi.com/markets/${raw.event_ticker.toLowerCase()}`
      : undefined,
    updatedAt: Date.now(),
    stale: false,
  };
}

function loadPrivateKey(): string | undefined {
  const inline = process.env.KALSHI_PRIVATE_KEY;
  if (inline) return inline.replaceAll("\\n", "\n");
  const path = process.env.KALSHI_PRIVATE_KEY_PATH;
  if (!path) return undefined;
  return readFileSync(path, "utf8");
}

export function createKalshiHeaders(
  keyId: string,
  privateKey: string,
  timestamp = Date.now(),
): Record<string, string> {
  const timestampString = String(timestamp);
  const signer = createSign("RSA-SHA256");
  signer.update(`${timestampString}GET${SOCKET_PATH}`);
  signer.end();
  const signature = signer
    .sign({
      key: privateKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    })
    .toString("base64");
  return {
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "KALSHI-ACCESS-TIMESTAMP": timestampString,
  };
}

type KalshiProviderOptions = {
  fetcher?: typeof fetch;
  pageSize?: number;
  refreshMs?: number;
  keyId?: string;
  privateKey?: string;
};

export class KalshiProvider implements MarketProvider {
  readonly source = "kalshi" as const;
  private readonly fetcher: typeof fetch;
  private readonly pageSize: number;
  private readonly refreshMs: number;
  private readonly keyId?: string;
  private readonly privateKey?: string;
  private callbacks?: ProviderCallbacks;
  private stopped = false;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private socket?: WebSocket;
  private reconnectAttempts = 0;
  private nextCursor?: string;
  private paginationExhausted = false;
  private pageLoadPromise?: Promise<number>;
  private readonly marketsByTicker = new Map<string, MarketRecord>();

  constructor(options: KalshiProviderOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.pageSize = Math.min(
      MAX_MARKET_PAGE_SIZE,
      Math.max(1, Math.floor(options.pageSize ?? DEFAULT_MARKET_PAGE_SIZE)),
    );
    this.refreshMs = options.refreshMs ?? 30_000;
    this.keyId = options.keyId ?? process.env.KALSHI_API_KEY_ID;
    this.privateKey = options.privateKey ?? loadPrivateKey();
  }

  get hasMore(): boolean {
    return !this.paginationExhausted;
  }

  async start(callbacks: ProviderCallbacks): Promise<void> {
    if (this.callbacks) return;
    this.callbacks = callbacks;
    this.stopped = false;
    callbacks.status(providerStatus(this.source, "connecting", "Discovering markets"));

    try {
      await this.refreshMarkets();
      if (this.keyId && this.privateKey) this.connectSocket();
      else {
        callbacks.status(
          providerStatus(this.source, "polling", "REST live; add Kalshi keys for WebSocket"),
        );
      }
    } catch (error) {
      logger.warn({ error }, "Kalshi initial discovery failed");
      callbacks.status(providerStatus(this.source, "offline", "REST discovery unavailable"));
    }

    this.refreshTimer = setInterval(() => {
      void this.refreshMarkets().catch((error) => {
        logger.warn({ error }, "Kalshi metadata refresh failed");
        this.callbacks?.status(providerStatus(this.source, "stale", "Metadata refresh failed"));
      });
    }, this.refreshMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "Mobius shutdown");
    this.callbacks = undefined;
  }

  async loadMore(): Promise<number> {
    if (this.pageLoadPromise) return this.pageLoadPromise;
    if (this.paginationExhausted || !this.nextCursor) {
      this.paginationExhausted = true;
      return 0;
    }

    const cursor = this.nextCursor;
    this.pageLoadPromise = this.fetchAndApplyPage(cursor, true);
    try {
      return await this.pageLoadPromise;
    } catch (error) {
      this.callbacks?.status(providerStatus(this.source, "stale", "Could not load next page"));
      throw error;
    } finally {
      this.pageLoadPromise = undefined;
    }
  }

  private async refreshMarkets(): Promise<void> {
    await this.fetchAndApplyPage(undefined, this.marketsByTicker.size === 0);
  }

  private async fetchAndApplyPage(
    cursor: string | undefined,
    advancePagination: boolean,
  ): Promise<number> {
    const url = new URL(`${REST_BASE_URL}/markets`);
    url.searchParams.set("status", "open");
    url.searchParams.set("limit", String(this.pageSize));
    url.searchParams.set("mve_filter", "exclude");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await this.fetcher(url);
    if (!response.ok) throw new Error(`Kalshi discovery returned ${response.status}`);
    const payload = kalshiMarketsResponseSchema.parse(await response.json());
    if (advancePagination) {
      this.nextCursor = payload.cursor;
      this.paginationExhausted = !payload.cursor;
    }
    const selected = [...payload.markets]
      .sort(
        (a, b) =>
          asNumber(b.volume_24h_fp ?? b.volume_fp) - asNumber(a.volume_24h_fp ?? a.volume_fp),
      );

    const history = await this.fetchHistory(selected.map((market) => market.ticker));
    const previousTickers = new Set(this.marketsByTicker.keys());
    let added = 0;

    for (const raw of selected) {
      const normalized = normalizeKalshiMarket(raw, history.get(raw.ticker));
      const existing = this.marketsByTicker.get(raw.ticker);
      if (!existing) added += 1;
      const market = existing
        ? {
            ...normalized,
            history: history.get(raw.ticker) ?? existing.history,
            trades: existing.trades,
            bids: existing.bids.length > 1 ? existing.bids : normalized.bids,
            asks: existing.asks.length > 1 ? existing.asks : normalized.asks,
          }
        : normalized;
      market.change = market.yes - market.history[0];
      this.marketsByTicker.set(raw.ticker, market);
      this.callbacks?.upsert(market);
    }

    const membershipChanged =
      previousTickers.size !== this.marketsByTicker.size;
    if (membershipChanged && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.close(1000, "Refreshing market subscriptions");
    } else if (this.keyId && this.privateKey && !this.socket) {
      this.connectSocket();
    }

    this.callbacks?.status(
      providerStatus(
        this.source,
        this.socket?.readyState === WebSocket.OPEN ? "live" : "polling",
        this.socket?.readyState === WebSocket.OPEN
          ? `${this.marketsByTicker.size} streaming markets`
          : `${this.marketsByTicker.size} markets via REST${this.hasMore ? " · more available" : ""}`,
      ),
    );

    return added;
  }

  private async fetchHistory(tickers: string[]): Promise<Map<string, number[]>> {
    const result = new Map<string, number[]>();
    if (tickers.length === 0) return result;
    const now = Math.floor(Date.now() / 1000);
    const url = new URL(`${REST_BASE_URL}/markets/candlesticks`);
    url.searchParams.set("market_tickers", tickers.join(","));
    url.searchParams.set("start_ts", String(now - 7 * 24 * 60 * 60));
    url.searchParams.set("end_ts", String(now));
    url.searchParams.set("period_interval", "60");
    url.searchParams.set("include_latest_before_start", "true");
    const response = await this.fetcher(url);
    if (!response.ok) return result;
    const payload = batchCandlesticksSchema.safeParse(await response.json());
    if (!payload.success) return result;
    for (const item of payload.data.markets) {
      const prices = item.candlesticks
        .map((candle) =>
          asCents(
            candle.price.close_dollars ??
              candle.price.close ??
              candle.price.previous_dollars ??
              candle.price.previous,
            NaN,
          ),
        )
        .filter(Number.isFinite);
      if (prices.length > 0) result.set(item.market_ticker, prices.slice(-360));
    }
    return result;
  }

  private connectSocket(): void {
    if (
      this.stopped ||
      this.socket ||
      !this.keyId ||
      !this.privateKey ||
      this.marketsByTicker.size === 0
    ) {
      return;
    }

    let headers: Record<string, string>;
    try {
      headers = createKalshiHeaders(this.keyId, this.privateKey);
    } catch (error) {
      logger.error({ error }, "Unable to sign Kalshi WebSocket request");
      this.callbacks?.status(providerStatus(this.source, "offline", "Invalid Kalshi private key"));
      return;
    }

    const socket = new WebSocket(SOCKET_URL, { headers } as never);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.reconnectAttempts = 0;
      socket.send(
        JSON.stringify({
          id: 1,
          cmd: "subscribe",
          params: {
            channels: ["ticker", "trade", "orderbook_delta"],
            market_tickers: [...this.marketsByTicker.keys()],
            use_yes_price: true,
          },
        }),
      );
      this.callbacks?.status(
        providerStatus(this.source, "live", `${this.marketsByTicker.size} streaming markets`),
      );
    });
    socket.addEventListener("message", (event) => this.handleSocketMessage(event.data));
    socket.addEventListener("error", () => {
      this.callbacks?.status(providerStatus(this.source, "stale", "WebSocket interrupted"));
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = undefined;
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempts++);
    this.callbacks?.status(providerStatus(this.source, "stale", `Reconnecting in ${delay / 1000}s`));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectSocket();
    }, delay);
  }

  private handleSocketMessage(raw: unknown): void {
    let data: Record<string, unknown>;
    try {
      const parsed = JSON.parse(String(raw)) as unknown;
      if (!parsed || typeof parsed !== "object") return;
      data = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const message = data.msg;
    if (!message || typeof message !== "object") return;
    const payload = message as Record<string, unknown>;
    const ticker = typeof payload.market_ticker === "string" ? payload.market_ticker : undefined;
    if (!ticker) return;
    if (data.type === "ticker") this.applyTicker(ticker, payload);
    if (data.type === "trade") this.applyTrade(ticker, payload);
    if (data.type === "orderbook_snapshot") this.applyOrderbookSnapshot(ticker, payload);
    if (data.type === "orderbook_delta") this.applyOrderbookDelta(ticker, payload);
  }

  private applyTicker(ticker: string, payload: Record<string, unknown>): void {
    this.updateMarket(ticker, (market) => {
      const yesBid = asCents(payload.yes_bid_dollars, market.yesBid ?? NaN);
      const yesAsk = asCents(payload.yes_ask_dollars, market.yesAsk ?? NaN);
      const last = asCents(payload.price_dollars, market.yes);
      const yes =
        Number.isFinite(yesBid) && Number.isFinite(yesAsk) && yesAsk >= yesBid
          ? (yesBid + yesAsk) / 2
          : last;
      return this.withPrice(
        {
          ...market,
          yesBid: Number.isFinite(yesBid) ? yesBid : market.yesBid,
          yesAsk: Number.isFinite(yesAsk) ? yesAsk : market.yesAsk,
          volume: asNumber(payload.volume_fp, market.volume),
          liquidity: asNumber(payload.open_interest_fp, market.liquidity),
        },
        yes,
      );
    });
  }

  private applyTrade(ticker: string, payload: Record<string, unknown>): void {
    const price = asCents(payload.yes_price_dollars, NaN);
    if (!Number.isFinite(price)) return;
    this.updateMarket(ticker, (market) => {
      const next = this.withPrice(market, price);
      const side: "YES" | "NO" =
        String(payload.taker_side).toLowerCase() === "no" ? "NO" : "YES";
      return {
        ...next,
        trades: [
          {
            id: typeof payload.trade_id === "string" ? payload.trade_id : undefined,
            timestamp: asNumber(payload.ts_ms, Date.now()),
            side,
            price,
            size: asNumber(payload.count_fp),
          },
          ...market.trades,
        ].slice(0, 12),
      };
    });
  }

  private applyOrderbookSnapshot(ticker: string, payload: Record<string, unknown>): void {
    const bids = this.parseBookSide(payload.yes_dollars_fp, false);
    const asks = this.parseBookSide(payload.no_dollars_fp, true);
    this.updateMarket(ticker, (market) => ({
      ...market,
      bids,
      asks,
      yesBid: bids[0]?.price ?? market.yesBid,
      yesAsk: asks[0]?.price ?? market.yesAsk,
      updatedAt: Date.now(),
      stale: false,
    }));
  }

  private applyOrderbookDelta(ticker: string, payload: Record<string, unknown>): void {
    const price = asCents(payload.price_dollars, NaN);
    const delta = asNumber(payload.delta_fp, NaN);
    if (!Number.isFinite(price) || !Number.isFinite(delta)) return;
    this.updateMarket(ticker, (market) => {
      const side = String(payload.side).toLowerCase();
      const target = side === "yes" ? [...market.bids] : [...market.asks];
      const index = target.findIndex((level) => Math.abs(level.price - price) < 0.0001);
      const nextSize = Math.max(0, (index >= 0 ? target[index].size : 0) + delta);
      if (index >= 0 && nextSize === 0) target.splice(index, 1);
      else if (index >= 0) target[index] = { price, size: nextSize };
      else if (nextSize > 0) target.push({ price, size: nextSize });
      target.sort(side === "yes" ? (a, b) => b.price - a.price : (a, b) => a.price - b.price);
      const next = target.slice(0, 8);
      return {
        ...market,
        bids: side === "yes" ? next : market.bids,
        asks: side === "yes" ? market.asks : next,
        yesBid: side === "yes" ? next[0]?.price : market.yesBid,
        yesAsk: side === "yes" ? market.yesAsk : next[0]?.price,
        updatedAt: Date.now(),
        stale: false,
      };
    });
  }

  private parseBookSide(value: unknown, ascending: boolean): OrderLevel[] {
    if (!Array.isArray(value)) return [];
    return value
      .map((entry) =>
        Array.isArray(entry) && entry.length >= 2
          ? { price: asCents(entry[0]), size: asNumber(entry[1]) }
          : null,
      )
      .filter((entry): entry is OrderLevel => entry != null && entry.size > 0)
      .sort(ascending ? (a, b) => a.price - b.price : (a, b) => b.price - a.price)
      .slice(0, 8);
  }

  private withPrice(market: MarketRecord, yes: number): MarketRecord {
    const history = Math.abs(yes - market.history.at(-1)!) > 0.001
      ? [...market.history, yes].slice(-360)
      : market.history;
    return {
      ...market,
      yes,
      history,
      change: yes - history[0],
      stale: false,
      updatedAt: Date.now(),
    };
  }

  private updateMarket(
    ticker: string,
    updater: (market: MarketRecord) => MarketRecord,
  ): void {
    const market = this.marketsByTicker.get(ticker);
    if (!market) return;
    const updated = updater(market);
    this.marketsByTicker.set(ticker, updated);
    this.callbacks?.upsert(updated);
  }
}
