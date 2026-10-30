import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { boxesFromCells, changedAreas, mergeAreas } from "../src/visualdiff.js";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function png(dir: string, name: string, w: number, h: number, paint: (x: number, y: number) => [number, number, number]) {
  const img = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = paint(x, y); const i = (y * w + x) * 4; img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255; }
  const file = join(dir, name); await writeFile(file, PNG.sync.write(img)); return file;
}

describe("changed areas", () => {
  it("finds two separate changes as two boxes, and none for identical pictures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cl-vd-")); dirs.push(dir);
    const white = () => [255, 255, 255] as [number, number, number];
    const before = await png(dir, "b.png", 320, 240, white);
    const after = await png(dir, "a.png", 320, 240, (x, y) => (x >= 20 && x < 80 && y >= 20 && y < 40) || (x >= 200 && x < 300 && y >= 180 && y < 220) ? [0, 0, 0] : [255, 255, 255]);
    const found = await changedAreas(before, after);
    expect(found!.areas).toHaveLength(2);
    expect(found!.areas[0]).toMatchObject({ x: 16, y: 16 });
    expect((await changedAreas(before, before))!.areas).toEqual([]);
    expect(await changedAreas(before, join(dir, "missing.png"))).toBeNull();
  });
  it("counts a taller after picture as new content at the bottom", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cl-vd-")); dirs.push(dir);
    const found = await changedAreas(await png(dir, "b.png", 64, 64, () => [255, 255, 255]), await png(dir, "a.png", 64, 96, () => [255, 255, 255]));
    expect(found!.areas).toEqual([{ x: 0, y: 64, w: 64, h: 32 }]);
  });
  it("keeps at most five boxes, merging the closest", () => {
    const cells = Array.from({ length: 10 }, (_, r) => Array.from({ length: 40 }, (_, c) => r === 0 && c % 4 === 0));
    expect(boxesFromCells(cells).length).toBe(10);
    expect(mergeAreas(boxesFromCells(cells), 5)).toHaveLength(5);
  });
});
