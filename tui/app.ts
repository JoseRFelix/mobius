import {
  BoxRenderable,
  CliRenderer,
  TextRenderable,
  createCliRenderer,
  type CliRendererConfig,
  type KeyEvent,
} from "@opentui/core";
import { brailleChart, compactNumber, sizeNumber } from "./chart";
import { cloneMarkets, type Market } from "./markets";

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

type DashboardOptions = Pick<
  CliRendererConfig,
  "stdin" | "stdout" | "width" | "height" | "remote"
> & {
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

function buildBook(market: Market): string {
  const maxSize = Math.max(
    ...market.bids.map((level) => level.size),
    ...market.asks.map((level) => level.size),
  );
  const rows = market.bids.map((bid, index) => {
    const ask = market.asks[index];
    const bidBar = "█".repeat(Math.max(1, Math.round((bid.size / maxSize) * 7)));
    const askBar = "█".repeat(Math.max(1, Math.round((ask.size / maxSize) * 7)));
    return `${sizeNumber(bid.size).padStart(5)} ${bidBar.padStart(7)} ${bid.price
      .toFixed(1)
      .padStart(5)}  ${ask.price.toFixed(1).padStart(5)} ${askBar.padEnd(7)} ${sizeNumber(
      ask.size,
    ).padStart(5)}`;
  });

  return [" SIZE     BID PRICE    ASK     SIZE", ...rows].join("\n");
}

function buildTrades(market: Market): string {
  return [
    "TIME      SIDE  PRICE   SIZE",
    ...market.trades.map(
      (trade) =>
        `${trade.time}  ${trade.side.padEnd(4)}  ${trade.price
          .toFixed(1)
          .padStart(5)}c  ${sizeNumber(trade.size).padStart(5)}`,
    ),
  ].join("\n");
}

class MarketDashboard {
  private readonly renderer: CliRenderer;
  private readonly markets = cloneMarkets();
  private readonly marketRows: TextRenderable[] = [];
  private readonly marketPanel: BoxRenderable;
  private readonly lowerPanel: BoxRenderable;
  private readonly chartText: TextRenderable;
  private readonly chartPanel: BoxRenderable;
  private readonly bookText: TextRenderable;
  private readonly tradesText: TextRenderable;
  private readonly headerText: TextRenderable;
  private readonly footerText: TextRenderable;
  private readonly onQuit?: () => void;
  private selected = 0;
  private timeframe: Timeframe = "24H";
  private paused = false;
  private disposed = false;
  private tick = 0;
  private timer: ReturnType<typeof setInterval>;

  constructor(renderer: CliRenderer, onQuit?: () => void) {
    this.renderer = renderer;
    this.onQuit = onQuit;

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
      width: 38,
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
    const marketHeader = new TextRenderable(renderer, {
      id: "market-header",
      width: "100%",
      height: 2,
      content: "SELECT A CONTRACT\n──────────────────────────────────",
      fg: palette.muted,
      selectable: false,
    });
    this.marketPanel.add(marketHeader);

    for (let index = 0; index < this.markets.length; index += 1) {
      const row = new TextRenderable(renderer, {
        id: `market-${index}`,
        width: "100%",
        height: 3,
        content: "",
        fg: palette.ink,
        bg: palette.panel,
        truncate: true,
        selectable: false,
      });
      this.marketRows.push(row);
      this.marketPanel.add(row);
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
    this.timer = setInterval(() => this.updateMarketData(), 1_100);
    this.render();
  }

  private readonly handleKey = (key: KeyEvent) => {
    if (key.name === "down" || key.name === "j") {
      this.selected = (this.selected + 1) % this.markets.length;
    } else if (key.name === "up" || key.name === "k") {
      this.selected = (this.selected - 1 + this.markets.length) % this.markets.length;
    } else if (key.name === "1") {
      this.timeframe = "1H";
    } else if (key.name === "2") {
      this.timeframe = "24H";
    } else if (key.name === "3") {
      this.timeframe = "7D";
    } else if (key.name === "p" || key.name === "space") {
      this.paused = !this.paused;
    } else if (key.name === "q" || (key.name === "c" && key.ctrl)) {
      this.dispose();
      return;
    } else {
      return;
    }

    key.preventDefault();
    this.render();
  };

  private updateMarketData() {
    if (this.paused || this.disposed) return;
    this.tick += 1;

    for (let index = 0; index < this.markets.length; index += 1) {
      const market = this.markets[index];
      const wave = Math.sin((this.tick + index * 2.3) / 3.1) * 0.12;
      const jitter = (Math.random() - 0.5) * 0.24;
      const next = Math.min(99, Math.max(1, market.yes + wave + jitter));
      market.change += next - market.yes;
      market.yes = next;
      market.history.push(next);
      if (market.history.length > 180) market.history.shift();
      market.volume += Math.round(550 + Math.random() * 2_400);

      for (const level of market.bids) level.price = Math.max(1, level.price + jitter * 0.2);
      for (const level of market.asks) level.price = Math.min(99, level.price + jitter * 0.2);
    }

    const current = this.markets[this.selected];
    const now = new Date().toLocaleTimeString("en-US", { hour12: false });
    current.trades.unshift({
      time: now,
      side: Math.random() > 0.36 ? "YES" : "NO",
      price: Math.random() > 0.36 ? current.yes : 100 - current.yes,
      size: Math.round(40 + Math.random() * 1_200),
    });
    current.trades = current.trades.slice(0, 5);
    this.render();
  }

  private render() {
    const market = this.markets[this.selected];
    const now = new Date().toLocaleTimeString("en-US", { hour12: false });
    const connection = this.paused ? "PAUSED" : "LIVE";
    const compact = this.renderer.width < 92;
    this.marketPanel.visible = !compact;
    this.lowerPanel.visible = !compact && this.renderer.height >= 32;

    this.headerText.content = `MOBIUS / PREDICTION MARKETS     ${connection} ●     DEMO FEED     ${now}`;

    this.marketRows.forEach((row, index) => {
      const item = this.markets[index];
      const active = index === this.selected;
      const movement = signed(item.change);
      row.content = `${active ? "▸" : " "} ${item.category.padEnd(9)} ${clip(
        item.question,
        22,
      )}\n  YES ${item.yes.toFixed(1).padStart(5)}c  ${movement.padStart(6)}  VOL ${compactNumber(
        item.volume,
      ).padStart(6)}`;
      row.bg = active ? palette.selected : palette.panel;
      row.fg = active ? palette.green : item.change >= 0 ? palette.ink : palette.red;
    });

    const sampleCount = this.timeframe === "1H" ? 24 : this.timeframe === "24H" ? 72 : 180;
    const plotWidth = Math.max(
      18,
      Math.min(92, compact ? this.renderer.width - 8 : this.renderer.width - 48),
    );
    const plotRows = Math.max(
      5,
      Math.min(15, this.renderer.height - (this.lowerPanel.visible ? 22 : 11)),
    );
    const series = market.history.slice(-sampleCount);
    const movementColor = market.change >= 0 ? "UP" : "DOWN";

    this.chartPanel.title = ` ${clip(market.question.toUpperCase(), Math.max(24, plotWidth - 8))} `;
    this.chartText.content = [
      `YES ${market.yes.toFixed(1)}c  ${signed(market.change)} pts ${movementColor}   ${this.timeframe}   VOL ${compactNumber(
        market.volume,
      )}   LIQ ${compactNumber(market.liquidity)}`,
      "",
      brailleChart(series, plotWidth, plotRows),
    ].join("\n");
    this.bookText.content = buildBook(market);
    this.tradesText.content = buildTrades(market);
    this.footerText.content =
      "↑/k ↓/j select   1 1H   2 24H   3 7D   p pause   q quit     simulated data • OpenTUI 0.4";
    this.renderer.requestRender();
  }

  resize(width: number, height: number) {
    this.renderer.resize(Math.max(40, width), Math.max(22, height));
    this.render();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    this.renderer.keyInput.off("keypress", this.handleKey);
    this.renderer.destroy();
    this.onQuit?.();
  }
}

export async function createMarketDashboard(options: DashboardOptions = {}) {
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

  return new MarketDashboard(renderer, options.onQuit);
}
