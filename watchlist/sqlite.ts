import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  normalizeWatchlist,
  watchlistItemSchema,
  type WatchlistItem,
  type WatchlistRepository,
} from "./types";

export class SqliteWatchlistRepository implements WatchlistRepository {
  private readonly database: Database;

  constructor(path = process.env.MOBIUS_DB_PATH ?? resolve(".mobius/watchlist.sqlite")) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new Database(path, { create: true });
    this.database.run("PRAGMA journal_mode = WAL");
    this.database.run(`
      CREATE TABLE IF NOT EXISTS watchlist_items (
        watchlist_id TEXT NOT NULL,
        market_key TEXT NOT NULL,
        source TEXT NOT NULL,
        market_id TEXT NOT NULL,
        outcome_id TEXT,
        title TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (watchlist_id, market_key)
      )
    `);
  }

  async load(): Promise<WatchlistItem[]> {
    const rows = this.database
      .query<
        {
          watchlist_id: string;
          market_key: string;
          source: string;
          market_id: string;
          outcome_id: string | null;
          title: string;
          added_at: number;
          position: number;
        },
        []
      >(
        `SELECT watchlist_id, market_key, source, market_id, outcome_id, title, added_at, position
         FROM watchlist_items ORDER BY position ASC`,
      )
      .all();

    return normalizeWatchlist(
      rows.map((row) =>
        watchlistItemSchema.parse({
          watchlistId: row.watchlist_id,
          key: row.market_key,
          source: row.source,
          marketId: row.market_id,
          outcomeId: row.outcome_id ?? undefined,
          title: row.title,
          addedAt: row.added_at,
          position: row.position,
        }),
      ),
    );
  }

  async replace(items: WatchlistItem[]): Promise<void> {
    const normalized = normalizeWatchlist(items);
    const replace = this.database.transaction((next: WatchlistItem[]) => {
      this.database.run("DELETE FROM watchlist_items");
      const insert = this.database.prepare(`
        INSERT INTO watchlist_items (
          watchlist_id, market_key, source, market_id, outcome_id, title, added_at, position
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of next) {
        insert.run(
          item.watchlistId,
          item.key,
          item.source,
          item.marketId,
          item.outcomeId ?? null,
          item.title,
          item.addedAt,
          item.position,
        );
      }
    });
    replace(normalized);
  }

  close(): void {
    this.database.close();
  }
}
