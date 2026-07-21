"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { loadBrowserWatchlist, replaceBrowserWatchlist } from "../watchlist/browser";
import type { WatchlistItem } from "../watchlist/types";

type ConnectionState = "connecting" | "live" | "offline";

type BridgeMessage =
  | { type: "output"; data: string }
  | { type: "error"; message: string }
  | { type: "watchlist.persist"; items: WatchlistItem[] }
  | { type: "watchlist.ack"; count: number };

export function TerminalDashboard() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [attempt, setAttempt] = useState(0);
  const [watchlistCount, setWatchlistCount] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "block",
      disableStdin: false,
      fontFamily:
        '"SFMono-Regular", "Cascadia Code", "Liberation Mono", Menlo, monospace',
      fontSize: 13,
      letterSpacing: 0,
      lineHeight: 1.13,
      scrollback: 0,
      theme: {
        background: "#050907",
        foreground: "#d8e0da",
        cursor: "#61f3a6",
        cursorAccent: "#050907",
        selectionBackground: "#275b45",
        black: "#050907",
        brightBlack: "#718078",
        green: "#61f3a6",
        brightGreen: "#8dffc5",
        yellow: "#ffc861",
        brightYellow: "#ffe3a8",
        red: "#ff7185",
        brightRed: "#ffa0ad",
        white: "#d8e0da",
        brightWhite: "#ffffff",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();
    terminal.write("\x1b[2J\x1b[H\x1b[38;2;97;243;166mMOBIUS / starting OpenTUI bridge…\x1b[0m");

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const bridgeHost = process.env.NEXT_PUBLIC_TUI_BRIDGE_HOST ?? `${window.location.hostname}:3001`;
    const socket = new WebSocket(
      `${protocol}//${bridgeHost}/terminal?cols=${terminal.cols}&rows=${terminal.rows}`,
    );
    let localWatchlist: WatchlistItem[] = [];
    void loadBrowserWatchlist()
      .then((items) => {
        localWatchlist = items;
        setWatchlistCount(items.length);
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "watchlist.sync", items }));
        }
      })
      .catch(() => {
        terminal.writeln("\r\n\x1b[38;2;255;200;97mLocal watchlist storage is unavailable.\x1b[0m");
      });

    socket.addEventListener("open", () => {
      setConnection("live");
      terminal.clear();
      terminal.focus();
      socket.send(JSON.stringify({ type: "watchlist.sync", items: localWatchlist }));
    });

    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as BridgeMessage;
        if (message.type === "output") terminal.write(message.data);
        if (message.type === "error") {
          terminal.writeln(`\r\n\x1b[38;2;255;113;133m${message.message}\x1b[0m`);
        }
        if (message.type === "watchlist.persist") {
          localWatchlist = message.items;
          setWatchlistCount(message.items.length);
          void replaceBrowserWatchlist(message.items).catch(() => {
            terminal.writeln("\r\n\x1b[38;2;255;200;97mCould not persist the watchlist locally.\x1b[0m");
          });
        }
        if (message.type === "watchlist.ack") setWatchlistCount(message.count);
      } catch {
        terminal.write(String(event.data));
      }
    });

    socket.addEventListener("close", () => {
      setConnection("offline");
      terminal.writeln(
        "\r\n\x1b[38;2;255;200;97mBridge offline — run `npm run tui:web` and reconnect.\x1b[0m",
      );
    });

    socket.addEventListener("error", () => setConnection("offline"));

    const dataSubscription = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });

    let resizeFrame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        fit.fit();
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }),
          );
        }
      });
    });
    observer.observe(host);

    return () => {
      cancelAnimationFrame(resizeFrame);
      observer.disconnect();
      dataSubscription.dispose();
      socket.close();
      terminal.dispose();
    };
  }, [attempt]);

  return (
    <main className="site-shell">
      <header className="site-header">
        <div className="brand-lockup" aria-label="Mobius prediction market terminal">
          <span className="brand-mark" aria-hidden="true">M</span>
          <div>
            <p className="brand-name">MOBIUS</p>
            <p className="brand-subtitle">PREDICTION MARKET TERMINAL</p>
          </div>
        </div>
        <div className="header-meta">
          <span className={`connection-state connection-${connection}`}>
            <span aria-hidden="true">●</span>
            {connection === "live" ? "OPEN TUI LIVE" : connection.toUpperCase()}
          </span>
          {connection === "offline" ? (
            <button className="reconnect-button" onClick={() => {
              setConnection("connecting");
              setAttempt((value) => value + 1);
            }}>
              Reconnect
            </button>
          ) : null}
        </div>
      </header>

      <section className="terminal-frame" aria-label="Interactive prediction market terminal">
        <div className="terminal-chrome" aria-hidden="true">
          <div className="window-controls"><i /><i /><i /></div>
          <span>mobius — opentui / polymarket + kalshi</span>
          <span>{connection === "live" ? `${watchlistCount} watched` : "waiting"}</span>
        </div>
        <div ref={hostRef} className="terminal-host" />
      </section>

      <footer className="site-footer">
        <p>
          Scroll + load with <kbd>↑</kbd> <kbd>↓</kbd> · <kbd>/</kbd> search · <kbd>w</kbd> watch
        </p>
        <p>Live provider rows · watchlist stored on this device</p>
      </footer>
    </main>
  );
}
