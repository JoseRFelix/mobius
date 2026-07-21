export const DEFAULT_MARKET_PAGE_SIZE = 50;
export const MAX_MARKET_PAGE_SIZE = 100;

export function resolveMarketPageSize(
  value = process.env.MARKET_PAGE_SIZE ?? process.env.MARKET_LIMIT,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MARKET_PAGE_SIZE;
  return Math.min(MAX_MARKET_PAGE_SIZE, Math.floor(parsed));
}
