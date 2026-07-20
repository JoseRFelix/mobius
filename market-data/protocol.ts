import { z } from "zod";
import {
  marketKeySchema,
  marketRecordSchema,
  providerStatusSchema,
  type MarketKey,
  type MarketRecord,
  type ProviderStatus,
} from "./types";

export type MarketDataServerMessage =
  | {
      type: "snapshot";
      markets: MarketRecord[];
      providers: ProviderStatus[];
      generatedAt: number;
    }
  | { type: "market.upsert"; market: MarketRecord }
  | { type: "market.remove"; key: MarketKey }
  | { type: "provider.status"; provider: ProviderStatus }
  | { type: "error"; message: string };

export const marketDataClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), keys: z.array(marketKeySchema).max(250) }),
  z.object({ type: z.literal("unsubscribe"), keys: z.array(marketKeySchema).max(250) }),
  z.object({ type: z.literal("snapshot.get") }),
]);
export type MarketDataClientMessage = z.infer<typeof marketDataClientMessageSchema>;

export function encodeMarketDataMessage(message: MarketDataServerMessage): string {
  return JSON.stringify(message);
}

export function snapshotMessage(
  markets: MarketRecord[],
  providers: ProviderStatus[],
): MarketDataServerMessage {
  return {
    type: "snapshot",
    markets: markets.map((market) => marketRecordSchema.parse(market)),
    providers: providers.map((provider) => providerStatusSchema.parse(provider)),
    generatedAt: Date.now(),
  };
}
