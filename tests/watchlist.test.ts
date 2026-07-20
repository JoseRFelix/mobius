import { expect, test } from "bun:test";
import { SqliteWatchlistRepository } from "../watchlist/sqlite";
import { normalizeWatchlist, type WatchlistItem } from "../watchlist/types";

const item: WatchlistItem = {
  watchlistId: "default",
  key: "kalshi:RAIN-NYC",
  source: "kalshi",
  marketId: "RAIN-NYC",
  title: "Will it rain in New York?",
  addedAt: 100,
  position: 4,
};

test("watchlist normalization deduplicates and fixes positions", () => {
  const normalized = normalizeWatchlist([item, { ...item, addedAt: 200 }]);
  expect(normalized).toHaveLength(1);
  expect(normalized[0]?.position).toBe(0);
});

test("native watchlists persist in SQLite", async () => {
  const repository = new SqliteWatchlistRepository(":memory:");
  await repository.replace([item]);
  expect(await repository.load()).toEqual([{ ...item, position: 0 }]);
  repository.close();
});
