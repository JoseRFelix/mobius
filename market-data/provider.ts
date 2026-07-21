import type { MarketRecord, MarketSource, ProviderStatus } from "./types";

export type ProviderCallbacks = {
  upsert(market: MarketRecord): void;
  remove(key: MarketRecord["key"]): void;
  status(status: ProviderStatus): void;
};

export interface MarketProvider {
  readonly source: MarketSource;
  readonly hasMore?: boolean;
  start(callbacks: ProviderCallbacks): Promise<void>;
  loadMore?(): Promise<number>;
  stop(): void;
}

export function providerStatus(
  source: MarketSource,
  state: ProviderStatus["state"],
  message?: string,
): ProviderStatus {
  return { source, state, message, updatedAt: Date.now() };
}
