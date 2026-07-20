import { openDB, type DBSchema } from "idb";
import {
  DEFAULT_WATCHLIST_ID,
  normalizeWatchlist,
  watchlistItemSchema,
  type WatchlistItem,
} from "./types";

type StoredWatchlistItem = WatchlistItem & { storageKey: string };

interface MobiusWatchlistDatabase extends DBSchema {
  watchlists: {
    key: string;
    value: { id: string; name: string; updatedAt: number };
  };
  watchlistItems: {
    key: string;
    value: StoredWatchlistItem;
    indexes: { "by-watchlist": string };
  };
}

let databasePromise: ReturnType<typeof openDB<MobiusWatchlistDatabase>> | undefined;

function getDatabase() {
  databasePromise ??= openDB<MobiusWatchlistDatabase>("mobius", 1, {
    upgrade(database) {
      database.createObjectStore("watchlists", { keyPath: "id" });
      const items = database.createObjectStore("watchlistItems", { keyPath: "storageKey" });
      items.createIndex("by-watchlist", "watchlistId");
    },
  });
  return databasePromise;
}

export async function loadBrowserWatchlist(): Promise<WatchlistItem[]> {
  const database = await getDatabase();
  const stored = await database.getAllFromIndex(
    "watchlistItems",
    "by-watchlist",
    DEFAULT_WATCHLIST_ID,
  );
  return normalizeWatchlist(
    stored.map((item) =>
      watchlistItemSchema.parse({
        watchlistId: item.watchlistId,
        key: item.key,
        source: item.source,
        marketId: item.marketId,
        outcomeId: item.outcomeId,
        title: item.title,
        addedAt: item.addedAt,
        position: item.position,
      }),
    ),
  );
}

export async function replaceBrowserWatchlist(items: WatchlistItem[]): Promise<void> {
  const normalized = normalizeWatchlist(items);
  const database = await getDatabase();
  const transaction = database.transaction(["watchlists", "watchlistItems"], "readwrite");
  const existing = await transaction.objectStore("watchlistItems").index("by-watchlist").getAllKeys(
    DEFAULT_WATCHLIST_ID,
  );
  await Promise.all(existing.map((key) => transaction.objectStore("watchlistItems").delete(key)));
  await transaction.objectStore("watchlists").put({
    id: DEFAULT_WATCHLIST_ID,
    name: "Watchlist",
    updatedAt: Date.now(),
  });
  await Promise.all(
    normalized.map((item) =>
      transaction.objectStore("watchlistItems").put({
        ...item,
        storageKey: `${item.watchlistId}:${item.key}`,
      }),
    ),
  );
  await transaction.done;
}
