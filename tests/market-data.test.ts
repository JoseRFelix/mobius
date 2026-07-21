import { describe, expect, test } from "bun:test";
import { resolveMarketPageSize } from "../market-data/config";
import { MarketDataHub } from "../market-data/hub";
import type { MarketProvider, ProviderCallbacks } from "../market-data/provider";
import { KalshiProvider, normalizeKalshiMarket } from "../market-data/providers/kalshi";
import {
  normalizePolymarketMarket,
  PolymarketProvider,
} from "../market-data/providers/polymarket";
import type { MarketRecord } from "../market-data/types";
import { marketRowCapacity, marketWindow, searchMarkets } from "../tui/app";

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

class PagingFakeProvider implements MarketProvider {
  readonly source = "kalshi" as const;
  hasMore = true;
  private callbacks?: ProviderCallbacks;

  async start(callbacks: ProviderCallbacks): Promise<void> {
    this.callbacks = callbacks;
    callbacks.upsert(baseMarket);
  }

  async loadMore(): Promise<number> {
    if (!this.hasMore || !this.callbacks) return 0;
    this.hasMore = false;
    this.callbacks.upsert({
      ...baseMarket,
      key: "kalshi:NEXT",
      marketId: "NEXT",
      question: "Will the next page load?",
    });
    return 1;
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
  expect(marketRowCapacity(40, 100)).toBe(13);
  expect(marketRowCapacity(40, 5)).toBe(5);
  expect(marketRowCapacity(200, 1_000)).toBe(40);

  expect(marketWindow(40, 1_000, 500)).toEqual({ start: 494, end: 507, size: 13 });
  expect(marketWindow(40, 1_000, 999)).toEqual({ start: 987, end: 1_000, size: 13 });
});

test("market pagination defaults beyond twenty rows and respects provider page limits", () => {
  expect(resolveMarketPageSize(undefined)).toBe(50);
  expect(resolveMarketPageSize("75")).toBe(75);
  expect(resolveMarketPageSize("1000")).toBe(100);
  expect(resolveMarketPageSize("invalid")).toBe(50);
});

test("the hub appends provider pages without replacing its cache", async () => {
  const hub = new MarketDataHub({ providers: [new PagingFakeProvider()] });
  await hub.start();

  expect(hub.getMarkets()).toHaveLength(1);
  expect(hub.canLoadMore()).toBe(true);
  expect(await hub.loadMore()).toBe(1);
  expect(hub.getMarkets()).toHaveLength(2);
  expect(hub.canLoadMore()).toBe(false);

  hub.stop();
});

test("providers advance their official cursor parameters one page at a time", async () => {
  const polymarketRequests: URL[] = [];
  const polymarketFetcher = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    polymarketRequests.push(url);
    return Response.json({
      markets: [],
      ...(url.searchParams.has("after_cursor") ? {} : { next_cursor: "poly-next" }),
    });
  }) as typeof fetch;
  const polymarket = new PolymarketProvider({ fetcher: polymarketFetcher, pageSize: 25 });
  await polymarket.start({ upsert() {}, remove() {}, status() {} });
  await polymarket.loadMore();
  polymarket.stop();

  expect(polymarketRequests[0]?.searchParams.get("limit")).toBe("25");
  expect(polymarketRequests[0]?.searchParams.has("after_cursor")).toBe(false);
  expect(polymarketRequests[1]?.searchParams.get("after_cursor")).toBe("poly-next");
  expect(polymarket.hasMore).toBe(false);

  const kalshiRequests: URL[] = [];
  const kalshiFetcher = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    kalshiRequests.push(url);
    if (url.pathname.endsWith("/candlesticks")) return Response.json({ markets: [] });
    const cursor = url.searchParams.get("cursor");
    return Response.json({
      markets: [
        {
          ticker: cursor ? "PAGE-2" : "PAGE-1",
          title: cursor ? "Second page" : "First page",
          status: "open",
        },
      ],
      ...(cursor ? {} : { cursor: "kalshi-next" }),
    });
  }) as typeof fetch;
  const kalshi = new KalshiProvider({ fetcher: kalshiFetcher, pageSize: 25 });
  const kalshiMarkets: MarketRecord[] = [];
  await kalshi.start({ upsert: (market) => kalshiMarkets.push(market), remove() {}, status() {} });
  expect(await kalshi.loadMore()).toBe(1);
  kalshi.stop();

  const marketRequests = kalshiRequests.filter((url) => url.pathname.endsWith("/markets"));
  expect(marketRequests[0]?.searchParams.get("limit")).toBe("25");
  expect(marketRequests[0]?.searchParams.has("cursor")).toBe(false);
  expect(marketRequests[1]?.searchParams.get("cursor")).toBe("kalshi-next");
  expect(kalshiMarkets.map((market) => market.marketId)).toEqual(["PAGE-1", "PAGE-2"]);
  expect(kalshi.hasMore).toBe(false);
});

test("search ranks complete matches but includes records matching any query term", () => {
  const polymarket: MarketRecord = {
    ...baseMarket,
    key: "polymarket:condition:token",
    source: "polymarket",
    marketId: "condition",
    outcomeId: "token",
    category: "WEATHER",
    question: "Will it rain in London?",
  };
  const exact: MarketRecord = {
    ...polymarket,
    key: "polymarket:donald-trump:exact",
    marketId: "donald-trump",
    question: "Will Donald Trump win the election?",
    volume: 10,
  };
  const trumpOnly: MarketRecord = {
    ...polymarket,
    key: "polymarket:trump:only",
    marketId: "trump",
    question: "Will Trump attend the summit?",
    volume: 1_000,
  };
  const markets = [baseMarket, polymarket, trumpOnly, exact];

  expect(searchMarkets(markets, "poly london")[0]).toBe(polymarket);
  expect(searchMarkets(markets, "kalshi test")).toEqual([baseMarket]);
  const people = searchMarkets(markets, "donald trump");
  expect(people[0]).toBe(exact);
  expect(people).toContain(trumpOnly);
  expect(searchMarkets(markets, "missing")).toEqual([]);
  expect(searchMarkets(markets, " ")).toBe(markets);
});
