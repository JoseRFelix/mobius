import { resolveMarketPageSize } from "./config";
import { KalshiProvider } from "./providers/kalshi";
import { PolymarketProvider } from "./providers/polymarket";
import { snapshotMessage, type MarketDataServerMessage } from "./protocol";
import { providerStatus, type MarketProvider } from "./provider";
import type { MarketKey, MarketRecord, MarketSource, ProviderStatus } from "./types";

export type MarketDataEvent = Exclude<MarketDataServerMessage, { type: "error" }>;
export type MarketDataListener = (event: MarketDataEvent) => void;

type MarketDataHubOptions = {
  providers?: MarketProvider[];
};

export class MarketDataHub {
  private readonly providers: MarketProvider[];
  private readonly markets = new Map<MarketKey, MarketRecord>();
  private readonly statuses = new Map<MarketSource, ProviderStatus>();
  private readonly listeners = new Set<MarketDataListener>();
  private startPromise?: Promise<void>;
  private loadMorePromise?: Promise<number>;
  private stopped = false;

  constructor(options: MarketDataHubOptions = {}) {
    const pageSize = resolveMarketPageSize();
    this.providers = options.providers ?? [
      new PolymarketProvider({ pageSize }),
      new KalshiProvider({ pageSize }),
    ];

    for (const provider of this.providers) {
      this.statuses.set(provider.source, providerStatus(provider.source, "connecting", "Starting"));
    }
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.stopped = false;
    this.startPromise = Promise.allSettled(
      this.providers.map((provider) =>
        provider.start({
          upsert: (market) => this.upsert(market),
          remove: (key) => this.remove(key),
          status: (status) => this.setStatus(status),
        }),
      ),
    ).then(() => undefined);
    return this.startPromise;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const provider of this.providers) provider.stop();
    this.startPromise = undefined;
  }

  subscribe(listener: MarketDataListener, includeSnapshot = true): () => void {
    this.listeners.add(listener);
    if (includeSnapshot) listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): Extract<MarketDataEvent, { type: "snapshot" }> {
    return snapshotMessage(this.getMarkets(), this.getProviderStatuses()) as Extract<
      MarketDataEvent,
      { type: "snapshot" }
    >;
  }

  getMarkets(): MarketRecord[] {
    return [...this.markets.values()].sort((a, b) => {
      if (a.source !== b.source) return a.source.localeCompare(b.source);
      return b.volume - a.volume;
    });
  }

  getProviderStatuses(): ProviderStatus[] {
    return [...this.statuses.values()].sort((a, b) => a.source.localeCompare(b.source));
  }

  canLoadMore(): boolean {
    return this.providers.some(
      (provider) => provider.loadMore != null && provider.hasMore !== false,
    );
  }

  async loadMore(): Promise<number> {
    if (this.loadMorePromise) return this.loadMorePromise;
    await this.start();
    const providers = this.providers.filter(
      (provider) => provider.loadMore != null && provider.hasMore !== false,
    );
    if (providers.length === 0) return 0;

    this.loadMorePromise = Promise.allSettled(
      providers.map((provider) => provider.loadMore!()),
    ).then((results) => {
      const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failures.length === results.length) {
        throw new AggregateError(
          failures.map((failure) => failure.reason),
          "Every provider failed to load another market page",
        );
      }
      return results.reduce(
        (total, result) => total + (result.status === "fulfilled" ? result.value : 0),
        0,
      );
    });

    try {
      return await this.loadMorePromise;
    } finally {
      this.loadMorePromise = undefined;
    }
  }

  private upsert(market: MarketRecord): void {
    this.markets.set(market.key, market);
    this.emit({ type: "market.upsert", market });
  }

  private remove(key: MarketKey): void {
    if (!this.markets.delete(key)) return;
    this.emit({ type: "market.remove", key });
  }

  private setStatus(status: ProviderStatus): void {
    this.statuses.set(status.source, status);
    if (status.state === "stale" || status.state === "offline") {
      for (const [key, market] of this.markets) {
        if (market.source !== status.source || market.stale) continue;
        const staleMarket = { ...market, stale: true };
        this.markets.set(key, staleMarket);
        this.emit({ type: "market.upsert", market: staleMarket });
      }
    }
    this.emit({ type: "provider.status", provider: status });
  }

  private emit(event: MarketDataEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

const globalState = globalThis as typeof globalThis & {
  __mobiusMarketDataHub?: MarketDataHub;
};

export function getMarketDataHub(): MarketDataHub {
  globalState.__mobiusMarketDataHub ??= new MarketDataHub();
  return globalState.__mobiusMarketDataHub;
}
