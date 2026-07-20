import { getMarketDataHub } from "../market-data/hub";
import { SqliteWatchlistRepository } from "../watchlist/sqlite";
import { createMarketDashboard } from "./app";

const hub = getMarketDataHub();
const watchlist = new SqliteWatchlistRepository();
void hub.start();

const dashboard = await createMarketDashboard({
  stdin: process.stdin,
  stdout: process.stdout,
  width: process.stdout.columns,
  height: process.stdout.rows,
  remote: false,
  marketHub: hub,
  watchlist: await watchlist.load(),
  onWatchlistChange: (items) => watchlist.replace(items),
  onQuit: () => process.exit(0),
});

process.on("SIGWINCH", () => {
  dashboard.resize(process.stdout.columns, process.stdout.rows);
});

function shutdown(): void {
  dashboard.dispose();
  hub.stop();
  watchlist.close();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
