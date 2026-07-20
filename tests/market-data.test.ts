import { describe, expect, test } from "bun:test";
import { MarketDataHub } from "../market-data/hub";
import type { MarketProvider, ProviderCallbacks } from "../market-data/provider";
import { normalizeKalshiMarket } from "../market-data/providers/kalshi";
import { normalizePolymarketMarket } from "../market-data/providers/polymarket";
import type { MarketRecord } from "../market-data/types";
import { marketRowCapacity } from "../tui/app";

const baseMarket: MarketRecord = {
  key: "kalshi:TEST",
  source: "kalshi",
  marketId: "TEST",
  category: "TEST",
  question: "Will the test pass?",
  yes: 51,
  change: 1,
  volume: 100,
  liquidity: 200,
  history: [50, 51],
  bids: [],
  asks: [],
  trades: [],
  status: "active",
  updatedAt: 1,
  stale: false,
};

class FakeProvider implements MarketProvider {
  readonly source = "kalshi" as const;
  constructor(private readonly market: MarketRecord) {}
  async start(callbacks: ProviderCallbacks): Promise<void> {
    callbacks.upsert(this.market);
    callbacks.status({ source: this.source, state: "live", updatedAt: 2 });
  }
  stop(): void {}
}

describe("provider normalization", () => {
  test("Polymarket keys include the provider and outcome token", () => {
    const market = normalizePolymarketMarket({
      id: "1",
      conditionId: "condition-1",
      question: "Will it rain?",
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.62","0.38"]',
      clobTokenIds: '["yes-token","no-token"]',
      bestBid: 0.61,
      bestAsk: 0.63,
      volume24hrClob: 1_000,
      liquidityClob: 500,
      acceptingOrders: true,
    });

    expect(market?.key).toBe("polymarket:condition-1:yes-token");
    expect(market?.yes).toBe(62);
    expect(market?.source).toBe("polymarket");
  });

  test("Kalshi keys stay separate from Polymarket keys", () => {
    const market = normalizeKalshiMarket({
      ticker: "RAIN-NYC",
      title: "Will it rain in New York?",
      status: "active",
      yes_bid_dollars: "0.40",
      yes_ask_dollars: "0.44",
      volume_24h_fp: "250",
      liquidity_dollars: "1000",
    });

    expect(market.key).toBe("kalshi:RAIN-NYC");
    expect(market.yes).toBe(42);
    expect(market.source).toBe("kalshi");
  });
});

test("the hub snapshots and broadcasts provider rows without merging", async () => {
  const hub = new MarketDataHub({ providers: [new FakeProvider(baseMarket)] });
  const eventTypes: string[] = [];
  const unsubscribe = hub.subscribe((event) => eventTypes.push(event.type));
  await hub.start();

  expect(hub.getMarkets()).toEqual([baseMarket]);
  expect(hub.getProviderStatuses()[0]?.state).toBe("live");
  expect(eventTypes).toContain("market.upsert");
  expect(eventTypes).toContain("provider.status");

  unsubscribe();
  hub.stop();
});

test("the market rail uses all rows that fit the viewport", () => {
  expect(marketRowCapacity(72, 20)).toBe(20);
  expect(marketRowCapacity(40, 20)).toBe(13);
  expect(marketRowCapacity(40, 5)).toBe(5);
});
