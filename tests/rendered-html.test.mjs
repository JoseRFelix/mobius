import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Mobius browser terminal shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Mobius — Prediction Market Terminal<\/title>/i);
  assert.match(html, /MOBIUS/);
  assert.match(html, /PREDICTION MARKET TERMINAL/);
  assert.match(html, /Interactive prediction market terminal/);
  assert.match(html, /property="og:image"/);
  assert.match(html, /\/og\.png/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|SkeletonPreview/);
});

test("keeps the OpenTUI runtime and browser bridge wired together", async () => {
  const [packageJson, bridge, dashboard, browserClient] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../tui/server.ts", import.meta.url), "utf8"),
    readFile(new URL("../tui/app.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/terminal-dashboard.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(packageJson, /"@opentui\/core"/);
  assert.match(packageJson, /"@xterm\/xterm"/);
  assert.match(packageJson, /"tui:web": "bun run tui\/server\.ts"/);
  assert.match(bridge, /createMarketDashboard/);
  assert.match(bridge, /Bun\.serve/);
  assert.match(dashboard, /createCliRenderer/);
  assert.match(dashboard, /brailleChart/);
  assert.match(browserClient, /new WebSocket/);
  assert.match(browserClient, /new Terminal/);
});
