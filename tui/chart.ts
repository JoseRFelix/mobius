const BRAILLE_BASE = 0x2800;

const dotBits = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

function drawLine(
  pixels: boolean[][],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) {
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let error = dx + dy;
  let x = x0;
  let y = y0;

  while (true) {
    if (pixels[y]?.[x] !== undefined) pixels[y][x] = true;
    if (x === x1 && y === y1) break;
    const twice = 2 * error;
    if (twice >= dy) {
      error += dy;
      x += sx;
    }
    if (twice <= dx) {
      error += dx;
      y += sy;
    }
  }
}

export function brailleChart(values: number[], columns: number, rows: number): string {
  const width = Math.max(18, columns) * 2;
  const height = Math.max(5, rows) * 4;
  const source = values.length > width ? values.slice(-width) : values;
  const low = Math.max(0, Math.floor(Math.min(...source) - 4));
  const high = Math.min(100, Math.ceil(Math.max(...source) + 4));
  const range = Math.max(1, high - low);
  const pixels = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => false),
  );

  const points = source.map((value, index) => ({
    x: Math.round((index / Math.max(1, source.length - 1)) * (width - 1)),
    y: Math.round((1 - (value - low) / range) * (height - 1)),
  }));

  for (let index = 1; index < points.length; index += 1) {
    drawLine(
      pixels,
      points[index - 1].x,
      points[index - 1].y,
      points[index].x,
      points[index].y,
    );
  }

  return Array.from({ length: rows }, (_, row) => {
    let output = "";

    for (let column = 0; column < columns; column += 1) {
      let mask = 0;
      for (let subY = 0; subY < 4; subY += 1) {
        for (let subX = 0; subX < 2; subX += 1) {
          if (pixels[row * 4 + subY]?.[column * 2 + subX]) {
            mask |= dotBits[subY][subX];
          }
        }
      }
      output += String.fromCodePoint(BRAILLE_BASE + mask);
    }

    const axis = row === 0 ? `${high}c` : row === rows - 1 ? `${low}c` : "";
    return `${axis.padStart(4)} ${output}`;
  }).join("\n");
}

export function compactNumber(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(0)}`;
}

export function sizeNumber(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : value.toFixed(0);
}
