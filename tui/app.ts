import {
  BoxRenderable,
  CliRenderer,
  TextRenderable,
  createCliRenderer,
  type CliRendererConfig,
  type KeyEvent,
} from "@opentui/core";
import type { MarketDataEvent, MarketDataHub } from "../market-data/hub";
import type { MarketKey, MarketRecord, ProviderStatus } from "../market-data/types";
import {
  marketToWatchlistItem,
  normalizeWatchlist,
  type WatchlistItem,
} from "../watchlist/types";
import { brailleChart, compactNumber, sizeNumber } from "./chart";

const palette = {
  ink: "#d8e0da",
  muted: "#718078",
  green: "#61f3a6",
  greenDim: "#1b5b41",
  amber: "#ffc861",
  red: "#ff7185",
  panel: "#09110e",
  selected: "#123226",
  border: "#214234",
  background: "#050907",
};

const maxMarketRows = 40;

export type DashboardOptions = Pick<
  CliRendererConfig,
  "stdin" | "stdout" | "width" | "height" | "remote"
> & {
  marketHub: MarketDataHub;
  watchlist?: WatchlistItem[];
  onWatchlistChange?: (items: WatchlistItem[]) => void | Promise<void>;
  onQuit?: () => void;
};

type Timeframe = "1H" | "24H" | "7D";

function clip(value: string, width: number): string {
  if (value.length <= width) return value;
  return `${value.slice(0, Math.max(0, width - 1))}…`;
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
}

function sourceLabel(market: MarketRecord): string {
  return market.source === "polymarket" ? "POLY" : "KALSHI";
}

function sourceMark(market: MarketRecord): string {
  return market.source === "polymarket" ? "◈" : "K";
}

function sourceColor(market: MarketRecord): string {
  return market.source === "polymarket" ? "#6f8cff" : palette.green;
}

function volumeLabel(market: MarketRecord): string {
  return market.source === "polymarket" ? compactNumber(market.volume) : sizeNumber(market.volume);
}

export function marketRowCapacity(viewportHeight: number, marketCount: number): number {
  const availableHeight = Math.max(2, viewportHeight - 14);
  const rowsThatFit = Math.max(1, Math.floor(availableHeight / 2));
  return Math.min(maxMarketRows, Math.max(1, marketCount), rowsThatFit);
}

function buildBook(market: MarketRecord): string {
  if (market.bids.length === 0 && market.asks.length === 0) {
    return " SIZE     BID PRICE    ASK     SIZE\n\n      Waiting for book data…";
  }
  const maxSize = Math.max(
    1,
    ...market.bids.map((level) => level.size),
    ...market.asks.map((level) => level.size),
  );
  const rowCount = Math.min(5, Math.max(market.bids.length, market.asks.length));
  const rows = Array.from({ length: rowCount }, (_, index) => {
    const bid = market.bids[index];
    const ask = market.asks[index];
    const bidBar = bid ? "█".repeat(Math.max(1, Math.round((bid.size / maxSize) * 7))) : "";
    const askBar = ask ? "█".repeat(Math.max(1, Math.round((ask.size / maxSize) * 7))) : "";
    return `${bid ? sizeNumber(bid.size).padStart(5) : "     "} ${bidBar.padStart(7)} ${
      bid ? bid.price.toFixed(1).padStart(5) : "     "
    }  ${ask ? ask.price.toFixed(1).padStart(5) : "     "} ${askBar.padEnd(7)} ${
      ask ? sizeNumber(ask.size).padStart(5) : "     "
    }`;
  });
  return [" SIZE     BID PRICE    ASK     SIZE", ...rows].join("\n");
}

function buildTrades(market: MarketRecord): string {
  if (market.trades.length === 0) return "TIME      SIDE  PRICE   SIZE\n\nWaiting for trades…";
  return [
    "TIME      SIDE  PRICE   SIZE",
    ...market.trades.slice(0, 5).map((trade) => {
      const time = new Date(trade.timestamp).toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      return `${time}  ${trade.side.padEnd(4)}  ${trade.price
        .toFixed(1)
        .padStart(5)}c  ${sizeNumber(trade.size).padStart(5)}`;
    }),
  ].join("\n");
}

class MarketDashboard {
  private readonly renderer: CliRenderer;
  private readonly hub: MarketDataHub;
  private readonly marketRows: Array<{
    container: BoxRenderable;
    mark: TextRenderable;
    details: TextRenderable;
  }> = [];
  private readonly marketPanel: BoxRenderable;
  private readonly lowerPanel: BoxRenderable;
  private readonly chartText: TextRenderable;
  private readonly chartPanel: BoxRenderable;
  private readonly bookText: TextRenderable;
  private readonly tradesText: TextRenderable;
  private readonly headerText: TextRenderable;
  private readonly footerText: TextRenderable;
  private readonly onWatchlistChange?: (items: WatchlistItem[]) => void | Promise<void>;
  private readonly onQuit?: () => void;
  private readonly marketsByKey = new Map<MarketKey, MarketRecord>();
  private readonly providers = new Map<MarketRecord["source"], ProviderStatus>();
  private watchlist: WatchlistItem[];
  private unsubscribe: () => void;
  private selected = 0;
  private timeframe: Timeframe = "24H";
  private paused = false;
  private watchlistOnly = false;
  private disposed = false;

  constructor(renderer: CliRenderer, options: DashboardOptions) {
    this.renderer = renderer;
    this.hub = options.marketHub;
    this.watchlist = normalizeWatchlist(options.watchlist ?? []);
    this.onWatchlistChange = options.onWatchlistChange;
    this.onQuit = options.onQuit;

    const root = new BoxRenderable(renderer, {
      id: "mobius-root",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      padding: 1,
      gap: 1,
      backgroundColor: palette.background,
    });

    const header = new BoxRenderable(renderer, {
      id: "header",
      width: "100%",
      height: 3,
      border: true,
      borderStyle: "single",
      borderColor: palette.greenDim,
      backgroundColor: palette.panel,
      paddingX: 1,
    });
    this.headerText = new TextRenderable(renderer, {
      id: "header-text",
      width: "100%",
      height: 1,
      fg: palette.green,
      content: "",
      truncate: true,
    });
    header.add(this.headerText);

    const content = new BoxRenderable(renderer, {
      id: "content",
      width: "100%",
      flexGrow: 1,
      flexDirection: "row",
      gap: 1,
      backgroundColor: palette.background,
    });

    this.marketPanel = new BoxRenderable(renderer, {
      id: "markets",
      width: 42,
      height: "100%",
      flexDirection: "column",
      border: true,
      borderStyle: "single",
      borderColor: palette.border,
      title: " MARKETS ",
      titleColor: palette.amber,
      padding: 1,
      backgroundColor: palette.panel,
    });
    this.marketPanel.add(
      new TextRenderable(renderer, {
        id: "market-header",
        width: "100%",
        height: 2,
        content: "SRC   CONTRACT                            \n──────────────────────────────────────",
        fg: palette.muted,
        selectable: false,
      }),
    );

    for (let index = 0; index < maxMarketRows; index += 1) {
      const container = new BoxRenderable(renderer, {
        id: `market-${index}`,
        width: "100%",
        height: 2,
        minHeight: 2,
        flexGrow: 1,
        flexShrink: 0,
        flexDirection: "row",
        backgroundColor: palette.panel,
        visible: false,
      });
      const mark = new TextRenderable(renderer, {
        id: `market-${index}-mark`,
        width: 5,
        height: 2,
        content: "",
        fg: palette.muted,
        truncate: true,
        selectable: false,
      });
      const details = new TextRenderable(renderer, {
        id: `market-${index}-details`,
        flexGrow: 1,
        height: 2,
        content: "",
        fg: palette.ink,
        truncate: true,
        selectable: false,
      });
      container.add(mark);
      container.add(details);
      this.marketRows.push({ container, mark, details });
      this.marketPanel.add(container);
    }

    const main = new BoxRenderable(renderer, {
      id: "main",
      flexGrow: 1,
      height: "100%",
      flexDirection: "column",
      gap: 1,
      backgroundColor: palette.background,
    });
    this.chartPanel = new BoxRenderable(renderer, {
      id: "chart-panel",
      width: "100%",
      flexGrow: 1,
      minHeight: 12,
      border: true,
      borderStyle: "single",
      borderColor: palette.greenDim,
      title: " PROBABILITY ",
      titleColor: palette.green,
      padding: 1,
      backgroundColor: palette.panel,
    });
    this.chartText = new TextRenderable(renderer, {
      id: "chart",
      width: "100%",
      height: "100%",
      content: "",
      fg: palette.green,
      selectable: false,
      truncate: true,
    });
    this.chartPanel.add(this.chartText);

    this.lowerPanel = new BoxRenderable(renderer, {
      id: "lower",
      width: "100%",
      height: 10,
      flexDirection: "row",
      gap: 1,
      backgroundColor: palette.background,
    });
    const orderBook = new BoxRenderable(renderer, {
      id: "order-book",
      width: "56%",
      height: "100%",
      border: true,
      borderColor: palette.border,
      title: " ORDER BOOK ",
      titleColor: palette.amber,
      padding: 1,
      backgroundColor: palette.panel,
    });
    this.bookText = new TextRenderable(renderer, {
      id: "order-book-text",
      width: "100%",
      height: "100%",
      content: "",
      fg: palette.ink,
      truncate: true,
      selectable: false,
    });
    orderBook.add(this.bookText);

    const trades = new BoxRenderable(renderer, {
      id: "trades",
      flexGrow: 1,
      height: "100%",
      border: true,
      borderColor: palette.border,
      title: " RECENT TRADES ",
      titleColor: palette.amber,
      padding: 1,
      backgroundColor: palette.panel,
    });
    this.tradesText = new TextRenderable(renderer, {
      id: "trades-text",
      width: "100%",
      height: "100%",
      content: "",
      fg: palette.ink,
      truncate: true,
      selectable: false,
    });
    trades.add(this.tradesText);

    this.lowerPanel.add(orderBook);
    this.lowerPanel.add(trades);
    main.add(this.chartPanel);
    main.add(this.lowerPanel);
    content.add(this.marketPanel);
    content.add(main);

    const footer = new BoxRenderable(renderer, {
      id: "footer",
      width: "100%",
      height: 1,
      backgroundColor: palette.background,
    });
    this.footerText = new TextRenderable(renderer, {
      id: "footer-text",
      width: "100%",
      height: 1,
      content: "",
      fg: palette.muted,
      truncate: true,
      selectable: false,
    });
    footer.add(this.footerText);

    root.add(header);
    root.add(content);
    root.add(footer);
    renderer.root.add(root);

    renderer.keyInput.on("keypress", this.handleKey);
    this.unsubscribe = this.hub.subscribe(this.handleMarketEvent);
    this.render();
  }

  private get markets(): MarketRecord[] {
    const all = [...this.marketsByKey.values()].sort((a, b) => {
      if (a.source !== b.source) return a.source.localeCompare(b.source);
      return b.volume - a.volume;
    });
    if (!this.watchlistOnly) return all;
    const keys = new Set(this.watchlist.map((item) => item.key));
    return all.filter((market) => keys.has(market.key));
  }

  private readonly handleMarketEvent = (event: MarketDataEvent) => {
    if (event.type === "snapshot") {
      this.marketsByKey.clear();
      for (const market of event.markets) this.marketsByKey.set(market.key, market);
      this.providers.clear();
      for (const provider of event.providers) this.providers.set(provider.source, provider);
    } else if (event.type === "market.upsert") {
      this.marketsByKey.set(event.market.key, event.market);
    } else if (event.type === "market.remove") {
      this.marketsByKey.delete(event.key);
    } else if (event.type === "provider.status") {
      this.providers.set(event.provider.source, event.provider);
    }
    if (!this.paused) this.render();
  };

  private readonly handleKey = (key: KeyEvent) => {
    const markets = this.markets;
    if ((key.name === "down" || key.name === "j") && markets.length > 0) {
      this.selected = (this.selected + 1) % markets.length;
    } else if ((key.name === "up" || key.name === "k") && markets.length > 0) {
      this.selected = (this.selected - 1 + markets.length) % markets.length;
    } else if (key.name === "1") {
      this.timeframe = "1H";
    } else if (key.name === "2") {
      this.timeframe = "24H";
    } else if (key.name === "3") {
      this.timeframe = "7D";
    } else if (key.name === "p" || key.name === "space") {
      this.paused = !this.paused;
    } else if (key.name === "w" && markets[this.selected]) {
      this.toggleWatchlist(markets[this.selected]);
    } else if (key.name === "f") {
      this.watchlistOnly = !this.watchlistOnly;
      this.selected = 0;
    } else if (key.name === "q" || (key.name === "c" && key.ctrl)) {
      this.dispose();
      return;
    } else {
      return;
    }

    key.preventDefault();
    this.render();
  };

  setWatchlist(items: WatchlistItem[]): void {
    this.watchlist = normalizeWatchlist(items);
    if (this.selected >= this.markets.length) this.selected = Math.max(0, this.markets.length - 1);
    this.render();
  }

  private toggleWatchlist(market: MarketRecord): void {
    const index = this.watchlist.findIndex((item) => item.key === market.key);
    if (index >= 0) this.watchlist.splice(index, 1);
    else this.watchlist.push(marketToWatchlistItem(market, this.watchlist.length));
    this.watchlist = normalizeWatchlist(this.watchlist);
    void this.onWatchlistChange?.(this.watchlist);
  }

  private render(): void {
    const markets = this.markets;
    if (this.selected >= markets.length) this.selected = Math.max(0, markets.length - 1);
    const market = markets[this.selected];
    const now = new Date().toLocaleTimeString("en-US", { hour12: false });
    const compact = this.renderer.width < 96;
    this.marketPanel.visible = !compact;
    this.lowerPanel.visible = !compact && this.renderer.height >= 32;

    const providerLabel = (["polymarket", "kalshi"] as const)
      .map((source) => `${source === "polymarket" ? "POLY" : "KALSHI"}:${this.providers.get(source)?.state ?? "connecting"}`)
      .join("  ");
    this.headerText.content = `MOBIUS / PREDICTION MARKETS     ${this.paused ? "PAUSED" : "LIVE"} ●     ${providerLabel}     ${now}`;

    const visibleRowCount = marketRowCapacity(this.renderer.height, markets.length);
    const pageStart = Math.max(
      0,
      Math.min(
        Math.max(0, markets.length - visibleRowCount),
        this.selected - Math.floor(visibleRowCount / 2),
      ),
    );
    const visible = markets.slice(pageStart, pageStart + visibleRowCount);
    const watchlistKeys = new Set(this.watchlist.map((item) => item.key));
    this.marketRows.forEach(({ container, mark, details }, rowIndex) => {
      container.visible = rowIndex < visibleRowCount;
      if (!container.visible) return;
      const index = pageStart + rowIndex;
      const item = visible[rowIndex];
      if (!item) {
        mark.content = "";
        details.content = rowIndex === 0 && markets.length === 0
          ? `  ${this.watchlistOnly ? "No watched markets are currently loaded." : "Connecting to market providers…"}`
          : "";
        container.backgroundColor = palette.panel;
        details.fg = palette.muted;
        return;
      }
      const active = index === this.selected;
      const star = watchlistKeys.has(item.key) ? "★" : " ";
      const stale = item.stale ? "~" : " ";
      mark.content = `${active ? "▸" : " "} ${sourceMark(item)}\n ${star}${stale}`;
      mark.fg = sourceColor(item);
      details.content = `${clip(item.question, 31)}\nYES ${item.yes.toFixed(1).padStart(5)}c ${signed(
        item.change,
      ).padStart(6)}  VOL ${volumeLabel(
        item,
      ).padStart(7)}`;
      container.backgroundColor = active ? palette.selected : palette.panel;
      details.fg = active ? palette.green : item.change >= 0 ? palette.ink : palette.red;
    });

    if (!market) {
      this.chartPanel.title = " PROBABILITY ";
      this.chartText.content = this.watchlistOnly
        ? "Watchlist is empty or its markets are not in the current feed.\n\nPress f to show all markets, then w to add one."
        : "Loading real-time Polymarket and Kalshi markets…";
      this.bookText.content = "Waiting for market selection…";
      this.tradesText.content = "Waiting for market selection…";
    } else {
      const sampleCount = this.timeframe === "1H" ? 60 : this.timeframe === "24H" ? 144 : 360;
      const plotWidth = Math.max(
        18,
        Math.min(92, compact ? this.renderer.width - 8 : this.renderer.width - 52),
      );
      const plotRows = Math.max(
        5,
        Math.min(15, this.renderer.height - (this.lowerPanel.visible ? 22 : 11)),
      );
      const series = market.history.length > 0 ? market.history.slice(-sampleCount) : [market.yes];
      this.chartPanel.title = ` ${sourceLabel(market)} / ${clip(
        market.question.toUpperCase(),
        Math.max(24, plotWidth - 14),
      )} `;
      this.chartText.content = [
        `YES ${market.yes.toFixed(1)}c  ${signed(market.change)} pts   ${this.timeframe}   VOL ${volumeLabel(
          market,
        )}   LIQ ${compactNumber(market.liquidity)}${market.stale ? "   STALE" : ""}`,
        "",
        brailleChart(series, plotWidth, plotRows),
      ].join("\n");
      this.bookText.content = buildBook(market);
      this.tradesText.content = buildTrades(market);
    }
    this.marketPanel.title = ` ${this.watchlistOnly ? "WATCHLIST" : "MARKETS"} ${markets.length} `;
    this.footerText.content =
      "↑/k ↓/j select   w watch   f filter   1 1H   2 24H   3 7D   p pause   q quit     real provider feeds";
    this.renderer.requestRender();
  }

  resize(width: number, height: number): void {
    this.renderer.resize(Math.max(40, width), Math.max(22, height));
    this.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.renderer.keyInput.off("keypress", this.handleKey);
    this.renderer.destroy();
    this.onQuit?.();
  }
}

export async function createMarketDashboard(options: DashboardOptions) {
  const renderer = await createCliRenderer({
    stdin: options.stdin,
    stdout: options.stdout,
    width: options.width,
    height: options.height,
    remote: options.remote,
    targetFps: 20,
    maxFps: 30,
    exitOnCtrlC: false,
    exitSignals: [],
    clearOnShutdown: true,
    useMouse: false,
    useKittyKeyboard: null,
    consoleMode: "disabled",
    backgroundColor: palette.background,
  });

  return new MarketDashboard(renderer, options);
}
