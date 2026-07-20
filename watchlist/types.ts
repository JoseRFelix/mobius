import { z } from "zod";
import { marketKeySchema, marketSourceSchema, type MarketRecord } from "../market-data/types";

export const DEFAULT_WATCHLIST_ID = "default";

export const watchlistItemSchema = z.object({
  watchlistId: z.string().min(1).default(DEFAULT_WATCHLIST_ID),
  key: marketKeySchema,
  source: marketSourceSchema,
  marketId: z.string().min(1),
  outcomeId: z.string().optional(),
  title: z.string().min(1),
  addedAt: z.number().int().nonnegative(),
  position: z.number().int().nonnegative(),
});
export type WatchlistItem = z.infer<typeof watchlistItemSchema>;

export const watchlistItemsSchema = z.array(watchlistItemSchema).max(250);

export type WatchlistRepository = {
  load(): Promise<WatchlistItem[]>;
  replace(items: WatchlistItem[]): Promise<void>;
  close?(): void;
};

export function marketToWatchlistItem(
  market: MarketRecord,
  position: number,
): WatchlistItem {
  return watchlistItemSchema.parse({
    watchlistId: DEFAULT_WATCHLIST_ID,
    key: market.key,
    source: market.source,
    marketId: market.marketId,
    outcomeId: market.outcomeId,
    title: market.question,
    addedAt: Date.now(),
    position,
  });
}

export function normalizeWatchlist(items: WatchlistItem[]): WatchlistItem[] {
  const seen = new Set<string>();
  return watchlistItemsSchema
    .parse(items)
    .filter((item) => {
      if (seen.has(item.key)) return false;
      seen.add(item.key);
      return true;
    })
    .sort((a, b) => a.position - b.position)
    .map((item, position) => ({ ...item, position }));
}
