import { createMarketDashboard } from "./app";

const dashboard = await createMarketDashboard({
  stdin: process.stdin,
  stdout: process.stdout,
  width: process.stdout.columns,
  height: process.stdout.rows,
  remote: false,
  onQuit: () => process.exit(0),
});

process.on("SIGWINCH", () => {
  dashboard.resize(process.stdout.columns, process.stdout.rows);
});
