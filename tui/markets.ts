export type OrderLevel = {
  price: number;
  size: number;
};

export type Trade = {
  time: string;
  side: "YES" | "NO";
  price: number;
  size: number;
};

export type Market = {
  id: string;
  category: string;
  question: string;
  yes: number;
  change: number;
  volume: number;
  liquidity: number;
  history: number[];
  bids: OrderLevel[];
  asks: OrderLevel[];
  trades: Trade[];
};

function history(base: number, offsets: number[]): number[] {
  return offsets.map((offset) => Math.min(99, Math.max(1, base + offset)));
}

const curve = [
  -4.8, -4.4, -4.7, -3.9, -4.2, -3.6, -3.8, -2.9, -3.1, -2.6, -2.2,
  -2.5, -1.9, -1.4, -1.7, -0.8, -1.1, -0.4, 0.2, -0.1, 0.5, 0.8, 0.4,
  1.2, 1.5, 1.1, 1.9, 2.1, 1.7, 2.5, 2.8, 2.4, 3.1, 2.9, 3.6, 3.3,
  3.8, 4.1, 3.7, 4.4, 4.0, 4.7, 4.5, 5.0, 4.7, 5.3, 5.1, 5.6,
];

function book(mid: number): { bids: OrderLevel[]; asks: OrderLevel[] } {
  return {
    bids: [
      { price: mid - 0.3, size: 1320 },
      { price: mid - 0.7, size: 2880 },
      { price: mid - 1.1, size: 4360 },
      { price: mid - 1.6, size: 2190 },
      { price: mid - 2.1, size: 1680 },
    ],
    asks: [
      { price: mid + 0.3, size: 980 },
      { price: mid + 0.8, size: 2460 },
      { price: mid + 1.2, size: 3980 },
      { price: mid + 1.7, size: 2740 },
      { price: mid + 2.2, size: 1510 },
    ],
  };
}

function trades(mid: number): Trade[] {
  return [
    { time: "22:41:08", side: "YES", price: mid, size: 420 },
    { time: "22:40:56", side: "YES", price: mid - 0.2, size: 110 },
    { time: "22:40:31", side: "NO", price: 100 - mid + 0.1, size: 875 },
    { time: "22:39:58", side: "YES", price: mid - 0.4, size: 260 },
    { time: "22:39:42", side: "NO", price: 100 - mid + 0.3, size: 155 },
  ];
}

function market(
  id: string,
  category: string,
  question: string,
  yes: number,
  change: number,
  volume: number,
  liquidity: number,
  bias: number,
): Market {
  const levels = book(yes);

  return {
    id,
    category,
    question,
    yes,
    change,
    volume,
    liquidity,
    history: history(yes - curve[curve.length - 1] + bias, curve),
    bids: levels.bids,
    asks: levels.asks,
    trades: trades(yes),
  };
}

export const initialMarkets: Market[] = [
  market(
    "fed-sep",
    "MACRO",
    "Will the Fed cut rates by September?",
    64.2,
    2.4,
    12_480_000,
    1_840_000,
    0,
  ),
  market(
    "btc-150",
    "CRYPTO",
    "Bitcoin above $150k before January?",
    38.7,
    -1.8,
    8_920_000,
    970_000,
    -2.2,
  ),
  market(
    "cpi-3",
    "ECON",
    "US CPI below 3% in the next release?",
    71.4,
    0.9,
    4_760_000,
    680_000,
    1.4,
  ),
  market(
    "house-2026",
    "POLITICS",
    "Democrats win the House in 2026?",
    55.8,
    1.1,
    19_220_000,
    2_410_000,
    -0.8,
  ),
  market(
    "ai-model",
    "TECH",
    "A new #1 AI model launches this month?",
    46.3,
    3.7,
    2_840_000,
    540_000,
    2.8,
  ),
  market(
    "atlantic-storms",
    "CLIMATE",
    "Atlantic season exceeds 18 named storms?",
    62.1,
    -0.6,
    1_960_000,
    420_000,
    -1.6,
  ),
];

export function cloneMarkets(): Market[] {
  return initialMarkets.map((item) => ({
    ...item,
    history: [...item.history],
    bids: item.bids.map((level) => ({ ...level })),
    asks: item.asks.map((level) => ({ ...level })),
    trades: item.trades.map((trade) => ({ ...trade })),
  }));
}
