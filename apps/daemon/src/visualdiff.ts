import { readFile } from "node:fs/promises";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export type Area = { x: number; y: number; w: number; h: number };
const CELL = 16;

/** Joins boxes until at most `max` remain, always merging the pair that adds the least new area. */
export function mergeAreas(areas: Area[], max: number): Area[] {
  const boxes = [...areas];
  const union = (a: Area, b: Area): Area => { const x = Math.min(a.x, b.x); const y = Math.min(a.y, b.y); return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }; };
  while (boxes.length > max) {
    let best: [number, number, number] = [0, 1, Infinity];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const u = union(boxes[i]!, boxes[j]!);
      const cost = u.w * u.h - boxes[i]!.w * boxes[i]!.h - boxes[j]!.w * boxes[j]!.h;
      if (cost < best[2]) best = [i, j, cost];
    }
    const merged = union(boxes[best[0]]!, boxes[best[1]]!);
    boxes.splice(best[1], 1); boxes.splice(best[0], 1, merged);
  }
  return boxes;
}

/** Groups changed cells that touch (or nearly touch) into boxes, in image pixels. */
export function boxesFromCells(changed: boolean[][], cell = CELL): Area[] {
  const rows = changed.length; const cols = changed[0]?.length ?? 0;
  const seen = changed.map((r) => r.map(() => false));
  const boxes: Area[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (!changed[r]![c] || seen[r]![c]) continue;
    let [top, left, bottom, right] = [r, c, r, c];
    const stack = [[r, c]]; seen[r]![c] = true;
    while (stack.length) {
      const [y, x] = stack.pop()!;
      top = Math.min(top, y!); bottom = Math.max(bottom, y!); left = Math.min(left, x!); right = Math.max(right, x!);
      // A one-cell gap still counts as touching, so a line of text is one area, not one per word.
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const ny = y! + dy; const nx = x! + dx;
        if (ny >= 0 && ny < rows && nx >= 0 && nx < cols && changed[ny]![nx] && !seen[ny]![nx]) { seen[ny]![nx] = true; stack.push([ny, nx]); }
      }
    }
    boxes.push({ x: left * cell, y: top * cell, w: (right - left + 1) * cell, h: (bottom - top + 1) * cell });
  }
  return boxes;
}

/**
 * Where the after picture differs from the before picture, as at most `max` boxes. pixelmatch ignores
 * anti-aliasing, so a font smoothing difference is not a change. Null when either picture is missing.
 */
export async function changedAreas(before: string, after: string, max = 5): Promise<{ areas: Area[]; width: number; height: number } | null> {
  const [a, b] = await Promise.all([readFile(before), readFile(after)]).then(([x, y]) => [PNG.sync.read(x), PNG.sync.read(y)] as const).catch(() => [null, null] as const);
  if (!a || !b) return null;
  const width = Math.min(a.width, b.width); const height = Math.min(a.height, b.height);
  const crop = (img: PNG) => { if (img.width === width && img.height === height) return img.data; const out = Buffer.alloc(width * height * 4); for (let y = 0; y < height; y++) img.data.copy(out, y * width * 4, y * img.width * 4, y * img.width * 4 + width * 4); return out; };
  const mask = Buffer.alloc(width * height * 4);
  pixelmatch(crop(a), crop(b), mask, width, height, { threshold: 0.1, diffMask: true, diffColor: [255, 0, 0], diffColorAlt: [255, 0, 0], aaColor: [0, 0, 0] });
  const cols = Math.ceil(width / CELL); const rows = Math.ceil(height / CELL);
  const counts = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (mask[i + 3]! > 0 && mask[i]! === 255 && mask[i + 1]! === 0) counts[Math.floor(y / CELL)]![Math.floor(x / CELL)]!++;
  }
  const changed = counts.map((r) => r.map((n) => n >= 3));
  const areas = mergeAreas(boxesFromCells(changed), max).map((r) => ({ x: r.x, y: r.y, w: Math.min(r.w, width - r.x), h: Math.min(r.h, height - r.y) }));
  // A taller after picture is new content below everything before it.
  if (b.height > a.height) areas.push({ x: 0, y: a.height, w: b.width, h: b.height - a.height });
  return { areas: mergeAreas(areas, max), width: b.width, height: b.height };
}
