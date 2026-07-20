import { z } from "zod";

export const marketSourceSchema = z.enum(["polymarket", "kalshi"]);
export type MarketSource = z.infer<typeof marketSourceSchema>;

export const marketKeySchema = z
  .string()
  .refine(
    (value) => value.startsWith("polymarket:") || value.startsWith("kalshi:"),
    "Market keys must be provider-qualified",
  );
export type MarketKey = `${MarketSource}:${string}`;

export const orderLevelSchema = z.object({
  price: z.number().finite().min(0).max(100),
  size: z.number().finite().nonnegative(),
});
export type OrderLevel = z.infer<typeof orderLevelSchema>;

export const tradeSchema = z.object({
  id: z.string().optional(),
  timestamp: z.number().int().nonnegative(),
  side: z.enum(["YES", "NO"]),
  price: z.number().finite().min(0).max(100),
  size: z.number().finite().nonnegative(),
});
export type Trade = z.infer<typeof tradeSchema>;

export const marketRecordSchema = z.object({
  key: marketKeySchema.transform((value) => value as MarketKey),
  source: marketSourceSchema,
  marketId: z.string().min(1),
  outcomeId: z.string().optional(),
  category: z.string().default("OTHER"),
  question: z.string().min(1),
  yes: z.number().finite().min(0).max(100),
  yesBid: z.number().finite().min(0).max(100).optional(),
  yesAsk: z.number().finite().min(0).max(100).optional(),
  change: z.number().finite(),
  volume: z.number().finite().nonnegative(),
  liquidity: z.number().finite().nonnegative(),
  history: z.array(z.number().finite().min(0).max(100)),
  bids: z.array(orderLevelSchema),
  asks: z.array(orderLevelSchema),
  trades: z.array(tradeSchema),
  status: z.string(),
  url: z.string().url().optional(),
  updatedAt: z.number().int().nonnegative(),
  stale: z.boolean(),
});
export type MarketRecord = z.infer<typeof marketRecordSchema>;

export const providerConnectionStateSchema = z.enum([
  "connecting",
  "live",
  "polling",
  "stale",
  "offline",
]);
export type ProviderConnectionState = z.infer<typeof providerConnectionStateSchema>;

export const providerStatusSchema = z.object({
  source: marketSourceSchema,
  state: providerConnectionStateSchema,
  message: z.string().optional(),
  updatedAt: z.number().int().nonnegative(),
});
export type ProviderStatus = z.infer<typeof providerStatusSchema>;

export function asCents(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const cents = Math.abs(parsed) <= 1 ? parsed * 100 : parsed;
  return Math.min(100, Math.max(0, cents));
}

export function asNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function marketKey(source: MarketSource, ...parts: string[]): MarketKey {
  return `${source}:${parts.map((part) => encodeURIComponent(part)).join(":")}`;
}
