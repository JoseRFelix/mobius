"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";

type ConnectionState = "connecting" | "live" | "offline";

type BridgeMessage =
  | { type: "output"; data: string }
  | { type: "error"; message: string };

export function TerminalDashboard() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [attempt, setAttempt] = useState(0);

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

    socket.addEventListener("open", () => {
      setConnection("live");
      terminal.clear();
      terminal.focus();
    });

    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as BridgeMessage;
        if (message.type === "output") terminal.write(message.data);
        if (message.type === "error") {
          terminal.writeln(`\r\n\x1b[38;2;255;113;133m${message.message}\x1b[0m`);
        }
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
          <span>mobius — opentui / demo-feed</span>
          <span>{connection === "live" ? "20 fps" : "waiting"}</span>
        </div>
        <div ref={hostRef} className="terminal-host" />
      </section>

      <footer className="site-footer">
        <p>Navigate with <kbd>↑</kbd> <kbd>↓</kbd> or <kbd>j</kbd> <kbd>k</kbd></p>
        <p>Simulated market data · initial OpenTUI prototype</p>
      </footer>
    </main>
  );
}
