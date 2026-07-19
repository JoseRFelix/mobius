import { PassThrough, Writable } from "node:stream";
import { createMarketDashboard } from "./app";

class SocketWriteStream extends Writable {
  readonly isTTY = true;
  columns: number;
  rows: number;

  constructor(
    columns: number,
    rows: number,
    private readonly emitOutput: (value: string) => void,
  ) {
    super();
    this.columns = columns;
    this.rows = rows;
  }

  _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.emitOutput(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    callback();
  }

  getColorDepth() {
    return 24;
  }

  hasColors() {
    return true;
  }
}

type SocketSession = Awaited<ReturnType<typeof createMarketDashboard>>;

type SocketData = {
  session: SocketSession | null;
  input: PassThrough | null;
  output: SocketWriteStream | null;
  cols: number;
  rows: number;
  closed: boolean;
};

const port = Number(process.env.TUI_BRIDGE_PORT ?? 3001);

const server = Bun.serve<SocketData>({
  port,
  fetch(request, server) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "mobius-opentui-bridge" });
    }

    if (url.pathname !== "/terminal") {
      return new Response("Mobius OpenTUI bridge", { status: 200 });
    }

    const cols = Math.max(40, Number(url.searchParams.get("cols") ?? 120));
    const rows = Math.max(22, Number(url.searchParams.get("rows") ?? 40));
    const upgraded = server.upgrade(request, {
      data: {
        session: null,
        input: null,
        output: null,
        cols,
        rows,
        closed: false,
      },
    });

    return upgraded ? undefined : new Response("WebSocket upgrade required", { status: 426 });
  },
  websocket: {
    async open(socket) {
      const input = new PassThrough();
      Object.assign(input, {
        isTTY: true,
        isRaw: true,
        setRawMode: () => input,
      });

      const output = new SocketWriteStream(socket.data.cols, socket.data.rows, (value) => {
        if (!socket.data.closed) {
          socket.send(JSON.stringify({ type: "output", data: value }));
        }
      });
      socket.data.input = input;
      socket.data.output = output;

      try {
        const session = await createMarketDashboard({
          stdin: input as unknown as NodeJS.ReadStream,
          stdout: output as unknown as NodeJS.WriteStream,
          width: socket.data.cols,
          height: socket.data.rows,
          remote: true,
          onQuit: () => socket.close(1000, "Dashboard closed"),
        });
        socket.data.session = session;
        if (socket.data.closed) session.dispose();
      } catch (error) {
        socket.send(
          JSON.stringify({
            type: "error",
            message: error instanceof Error ? error.message : "Unable to start OpenTUI",
          }),
        );
        socket.close(1011, "OpenTUI failed to start");
      }
    },
    message(socket, message) {
      if (typeof message !== "string") return;

      try {
        const payload = JSON.parse(message) as
          | { type: "input"; data: string }
          | { type: "resize"; cols: number; rows: number };

        if (payload.type === "input") {
          socket.data.input?.write(payload.data);
        } else if (payload.type === "resize") {
          const cols = Math.max(40, Math.floor(payload.cols));
          const rows = Math.max(22, Math.floor(payload.rows));
          socket.data.cols = cols;
          socket.data.rows = rows;
          if (socket.data.output) {
            socket.data.output.columns = cols;
            socket.data.output.rows = rows;
          }
          socket.data.session?.resize(cols, rows);
        }
      } catch {
        socket.send(JSON.stringify({ type: "error", message: "Malformed client message" }));
      }
    },
    close(socket) {
      socket.data.closed = true;
      socket.data.session?.dispose();
      socket.data.input?.end();
      socket.data.output?.end();
    },
  },
});

console.log(`Mobius OpenTUI bridge listening on ws://localhost:${server.port}/terminal`);
