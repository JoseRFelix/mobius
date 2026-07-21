import { z } from "zod";
import { DEFAULT_MARKET_PAGE_SIZE, MAX_MARKET_PAGE_SIZE } from "../config";
import { logger } from "../logger";
import { providerStatus, type MarketProvider, type ProviderCallbacks } from "../provider";
import {
  asCents,
  asNumber,
  marketKey,
  type MarketRecord,
  type OrderLevel,
} from "../types";

const GAMMA_BASE_URL = "https://gamma-api.polymarket.com";
const CLOB_BASE_URL = "https://clob.polymarket.com";
const MARKET_SOCKET_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

const gammaMarketSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    question: z.string().nullable().optional(),
    conditionId: z.string(),
    slug: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    outcomes: z.union([z.string(), z.array(z.string())]).optional(),
    outcomePrices: z.union([z.string(), z.array(z.union([z.string(), z.number()]))]).optional(),
    clobTokenIds: z.union([z.string(), z.array(z.string())]).optional(),
    volume24hr: z.number().nullable().optional(),
    volume24hrClob: z.number().nullable().optional(),
    liquidityClob: z.number().nullable().optional(),
    liquidityNum: z.number().nullable().optional(),
    bestBid: z.number().nullable().optional(),
    bestAsk: z.number().nullable().optional(),
    lastTradePrice: z.number().nullable().optional(),
    endDate: z.string().nullable().optional(),
    acceptingOrders: z.boolean().nullable().optional(),
    events: z
      .array(
        z
          .object({
            slug: z.string().nullable().optional(),
            title: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const gammaResponseSchema = z.object({
  markets: z.array(gammaMarketSchema),
  next_cursor: z.string().optional(),
});

const historyResponseSchema = z.object({
  history: z.array(
    z.object({
      t: z.number(),
      p: z.union([z.string(), z.number()]),
    }),
  ),
});

type GammaMarket = z.infer<typeof gammaMarketSchema>;

function parseArray<T>(value: string | T[] | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function clampHistory(history: number[], fallback: number): number[] {
  const values = history.filter(Number.isFinite).map((value) => asCents(value));
  if (values.length > 0) return values.slice(-360);
  return Array.from({ length: 24 }, () => fallback);
}

export function normalizePolymarketMarket(
  raw: GammaMarket,
  priceHistory: number[] = [],
): MarketRecord | null {
  const outcomes = parseArray<string>(raw.outcomes);
  const prices = parseArray<string | number>(raw.outcomePrices);
  const tokens = parseArray<string>(raw.clobTokenIds);
  const yesIndex = Math.max(
    0,
    outcomes.findIndex((outcome) => outcome.toLowerCase() === "yes"),
  );
  const tokenId = tokens[yesIndex] ?? tokens[0];
  const question = raw.question?.trim();
  if (!tokenId || !question) return null;

  const last = asCents(raw.lastTradePrice ?? prices[yesIndex] ?? prices[0], 50);
  const yesBid = raw.bestBid == null ? undefined : asCents(raw.bestBid);
  const yesAsk = raw.bestAsk == null ? undefined : asCents(raw.bestAsk);
  const yes =
    yesBid != null && yesAsk != null && yesAsk >= yesBid ? (yesBid + yesAsk) / 2 : last;
  const history = clampHistory(priceHistory, yes);
  const eventSlug = raw.events?.[0]?.slug ?? raw.slug ?? undefined;

  return {
    key: marketKey("polymarket", raw.conditionId, tokenId),
    source: "polymarket",
    marketId: raw.conditionId,
    outcomeId: tokenId,
    category: (raw.category || "POLYMARKET").toUpperCase(),
    question,
    yes,
    yesBid,
    yesAsk,
    change: yes - history[0],
    volume: asNumber(raw.volume24hrClob ?? raw.volume24hr),
    liquidity: asNumber(raw.liquidityClob ?? raw.liquidityNum),
    history,
    bids: yesBid == null ? [] : [{ price: yesBid, size: 0 }],
    asks: yesAsk == null ? [] : [{ price: yesAsk, size: 0 }],
    trades: [],
    status: raw.acceptingOrders === false ? "paused" : "active",
    url: eventSlug ? `https://polymarket.com/event/${eventSlug}` : undefined,
    updatedAt: Date.now(),
    stale: false,
  };
}

function levels(value: unknown): OrderLevel[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const parsed = z
        .object({ price: z.union([z.string(), z.number()]), size: z.union([z.string(), z.number()]) })
        .safeParse(entry);
      return parsed.success
        ? { price: asCents(parsed.data.price), size: asNumber(parsed.data.size) }
        : null;
    })
    .filter((entry): entry is OrderLevel => entry != null);
}

type PolymarketProviderOptions = {
  fetcher?: typeof fetch;
  pageSize?: number;
  refreshMs?: number;
};

export class PolymarketProvider implements MarketProvider {
  readonly source = "polymarket" as const;
  private readonly fetcher: typeof fetch;
  private readonly pageSize: number;
  private readonly refreshMs: number;
  private callbacks?: ProviderCallbacks;
  private stopped = false;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private socket?: WebSocket;
  private reconnectAttempts = 0;
  private nextCursor?: string;
  private paginationExhausted = false;
  private pageLoadPromise?: Promise<number>;
  private readonly marketsByAsset = new Map<string, MarketRecord>();

  constructor(options: PolymarketProviderOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.pageSize = Math.min(
      MAX_MARKET_PAGE_SIZE,
      Math.max(1, Math.floor(options.pageSize ?? DEFAULT_MARKET_PAGE_SIZE)),
    );
    this.refreshMs = options.refreshMs ?? 5 * 60_000;
  }

  get hasMore(): boolean {
    return !this.paginationExhausted;
  }

  async start(callbacks: ProviderCallbacks): Promise<void> {
    if (this.callbacks) return;
    this.callbacks = callbacks;
    this.stopped = false;
    callbacks.status(providerStatus(this.source, "connecting", "Discovering CLOB markets"));

    try {
      await this.refreshMarkets();
      this.connectSocket();
    } catch (error) {
      logger.warn({ error }, "Polymarket initial discovery failed");
      callbacks.status(providerStatus(this.source, "offline", "REST discovery unavailable"));
    }

    this.refreshTimer = setInterval(() => {
      void this.refreshMarkets().catch((error) => {
        logger.warn({ error }, "Polymarket metadata refresh failed");
        this.callbacks?.status(providerStatus(this.source, "stale", "Metadata refresh failed"));
      });
    }, this.refreshMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
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
    await this.fetchAndApplyPage(undefined, this.marketsByAsset.size === 0);
  }

  private async fetchAndApplyPage(
    afterCursor: string | undefined,
    advancePagination: boolean,
  ): Promise<number> {
    const url = new URL("/markets/keyset", GAMMA_BASE_URL);
    url.searchParams.set("limit", String(this.pageSize));
    url.searchParams.set("closed", "false");
    url.searchParams.set("order", "volume24hr");
    url.searchParams.set("ascending", "false");
    if (afterCursor) url.searchParams.set("after_cursor", afterCursor);

    const response = await this.fetcher(url);
    if (!response.ok) throw new Error(`Polymarket discovery returned ${response.status}`);
    const payload = gammaResponseSchema.parse(await response.json());
    if (advancePagination) {
      this.nextCursor = payload.next_cursor;
      this.paginationExhausted = !payload.next_cursor;
    }
    const selected = payload.markets
      .filter((market) => market.acceptingOrders !== false)
      .map((market) => ({ market, normalized: normalizePolymarketMarket(market) }))
      .filter(
        (item): item is { market: GammaMarket; normalized: MarketRecord } =>
          item.normalized != null,
      );

    const previousAssets = new Set(this.marketsByAsset.keys());
    let added = 0;

    for (const { normalized } of selected) {
      const assetId = normalized.outcomeId!;
      const existing = this.marketsByAsset.get(assetId);
      if (!existing) added += 1;
      const market = existing
        ? {
            ...normalized,
            history: existing.history,
            trades: existing.trades,
            bids: existing.bids.length > 1 ? existing.bids : normalized.bids,
            asks: existing.asks.length > 1 ? existing.asks : normalized.asks,
          }
        : normalized;
      this.marketsByAsset.set(assetId, market);
      this.callbacks?.upsert(market);
    }

    this.updateSocketSubscriptions(previousAssets, new Set(this.marketsByAsset.keys()));
    this.callbacks?.status(
      providerStatus(
        this.source,
        this.socket?.readyState === WebSocket.OPEN ? "live" : "polling",
        `${this.marketsByAsset.size} markets${this.hasMore ? " · more available" : ""}`,
      ),
    );

    await Promise.allSettled(
      selected.map(async ({ normalized }) => {
        const assetId = normalized.outcomeId!;
        const history = await this.fetchHistory(assetId);
        const current = this.marketsByAsset.get(assetId);
        if (!current || history.length === 0) return;
        const next = {
          ...current,
          history,
          change: current.yes - history[0],
          updatedAt: Date.now(),
        };
        this.marketsByAsset.set(assetId, next);
        this.callbacks?.upsert(next);
      }),
    );

    return added;
  }

  private async fetchHistory(assetId: string): Promise<number[]> {
    const url = new URL("/prices-history", CLOB_BASE_URL);
    url.searchParams.set("market", assetId);
    url.searchParams.set("interval", "1w");
    url.searchParams.set("fidelity", "60");
    const response = await this.fetcher(url);
    if (!response.ok) return [];
    const payload = historyResponseSchema.safeParse(await response.json());
    return payload.success ? payload.data.history.map((point) => asCents(point.p)).slice(-360) : [];
  }

  private connectSocket(): void {
    if (this.stopped || this.socket || this.marketsByAsset.size === 0) return;
    const socket = new WebSocket(MARKET_SOCKET_URL);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectAttempts = 0;
      socket.send(
        JSON.stringify({
          assets_ids: [...this.marketsByAsset.keys()],
          type: "market",
          custom_feature_enabled: true,
        }),
      );
      this.heartbeatTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send("PING");
      }, 10_000);
      this.callbacks?.status(
        providerStatus(this.source, "live", `${this.marketsByAsset.size} streaming markets`),
      );
    });

    socket.addEventListener("message", (event) => this.handleSocketMessage(event.data));
    socket.addEventListener("error", () => {
      this.callbacks?.status(providerStatus(this.source, "stale", "WebSocket interrupted"));
    });
    socket.addEventListener("close", () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
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

  private updateSocketSubscriptions(previous: Set<string>, next: Set<string>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const added = [...next].filter((assetId) => !previous.has(assetId));
    const removed = [...previous].filter((assetId) => !next.has(assetId));
    if (added.length > 0) {
      this.socket.send(
        JSON.stringify({ assets_ids: added, operation: "subscribe", custom_feature_enabled: true }),
      );
    }
    if (removed.length > 0) {
      this.socket.send(JSON.stringify({ assets_ids: removed, operation: "unsubscribe" }));
    }
  }

  private handleSocketMessage(raw: unknown): void {
    if (raw === "PONG" || raw === "PING") return;
    let payload: unknown;
    try {
      payload = JSON.parse(String(raw));
    } catch {
      return;
    }

    const events = Array.isArray(payload) ? payload : [payload];
    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      const data = event as Record<string, unknown>;
      if (data.event_type === "price_change" && Array.isArray(data.price_changes)) {
        for (const change of data.price_changes) {
          if (change && typeof change === "object") this.applyPriceChange(change as Record<string, unknown>);
        }
        continue;
      }

      const assetId = typeof data.asset_id === "string" ? data.asset_id : undefined;
      if (!assetId) continue;
      if (data.event_type === "book") this.applyBook(assetId, data);
      if (data.event_type === "best_bid_ask") this.applyBestPrices(assetId, data);
      if (data.event_type === "last_trade_price") this.applyTrade(assetId, data);
      if (data.event_type === "market_resolved") {
        this.updateMarket(assetId, (market) => ({ ...market, status: "resolved", stale: true }));
      }
    }
  }

  private applyBook(assetId: string, data: Record<string, unknown>): void {
    const bids = levels(data.bids).sort((a, b) => b.price - a.price);
    const asks = levels(data.asks).sort((a, b) => a.price - b.price);
    this.updateMarket(assetId, (market) => {
      const yesBid = bids[0]?.price ?? market.yesBid;
      const yesAsk = asks[0]?.price ?? market.yesAsk;
      return this.withPrice(
        { ...market, bids: bids.slice(0, 8), asks: asks.slice(0, 8), yesBid, yesAsk },
        yesBid != null && yesAsk != null ? (yesBid + yesAsk) / 2 : market.yes,
      );
    });
  }

  private applyBestPrices(assetId: string, data: Record<string, unknown>): void {
    const yesBid = asCents(data.best_bid, NaN);
    const yesAsk = asCents(data.best_ask, NaN);
    if (!Number.isFinite(yesBid) || !Number.isFinite(yesAsk)) return;
    this.updateMarket(assetId, (market) =>
      this.withPrice({ ...market, yesBid, yesAsk }, (yesBid + yesAsk) / 2),
    );
  }

  private applyPriceChange(data: Record<string, unknown>): void {
    const assetId = typeof data.asset_id === "string" ? data.asset_id : undefined;
    if (!assetId) return;
    const yesBid = asCents(data.best_bid, NaN);
    const yesAsk = asCents(data.best_ask, NaN);
    this.updateMarket(assetId, (market) => {
      const nextBid = Number.isFinite(yesBid) ? yesBid : market.yesBid;
      const nextAsk = Number.isFinite(yesAsk) ? yesAsk : market.yesAsk;
      const nextPrice =
        nextBid != null && nextAsk != null ? (nextBid + nextAsk) / 2 : market.yes;
      return this.withPrice({ ...market, yesBid: nextBid, yesAsk: nextAsk }, nextPrice);
    });
  }

  private applyTrade(assetId: string, data: Record<string, unknown>): void {
    const price = asCents(data.price, NaN);
    if (!Number.isFinite(price)) return;
    this.updateMarket(assetId, (market) => {
      const timestamp = asNumber(data.timestamp, Date.now());
      const normalizedTimestamp = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
      const next = this.withPrice(market, price);
      const side: "YES" | "NO" = String(data.side).toUpperCase() === "SELL" ? "NO" : "YES";
      return {
        ...next,
        trades: [
          {
            timestamp: normalizedTimestamp,
            side,
            price,
            size: asNumber(data.size),
          },
          ...market.trades,
        ].slice(0, 12),
      };
    });
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
    assetId: string,
    updater: (market: MarketRecord) => MarketRecord,
  ): void {
    const market = this.marketsByAsset.get(assetId);
    if (!market) return;
    const updated = updater(market);
    this.marketsByAsset.set(assetId, updated);
    this.callbacks?.upsert(updated);
  }
}
