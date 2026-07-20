import pino from "pino";

export const logger = pino({
  name: "mobius-market-data",
  level: process.env.LOG_LEVEL ?? "info",
});
