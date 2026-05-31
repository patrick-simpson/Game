/* Pure-logic test: maze generation reachability (no DOM needed). */
const assert = require("node:assert");
const path = require("path");

global.window = {};
require(path.join(__dirname, "..", "js", "maze.js"));
const M = global.window.MMR;

function reachable(world) {
  const seen = new Set();
  const key = (x, y) => x + "," + y;
  const q = [[world.start.gx, world.start.gy]];
  seen.add(key(world.start.gx, world.start.gy));
  while (q.length) {
    const [x, y] = q.shift();
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= world.gw || ny >= world.gh) continue;
      if (world.grid[ny][nx] === 1) continue;
      if (seen.has(key(nx, ny))) continue;
      seen.add(key(nx, ny));
      q.push([nx, ny]);
    }
  }
  return seen;
}

let mazes = 0;
for (const diff of ["EASY", "NORMAL", "HARD"]) {
  for (let i = 0; i < 40; i++) {
    const w = new M.World(diff);
    const seen = reachable(w);
    assert.ok(seen.has(w.vip.gx + "," + w.vip.gy), `VIP reachable (${diff})`);
    assert.notStrictEqual(w.vip.gx + "," + w.vip.gy, w.start.gx + "," + w.start.gy, "VIP != start");
    for (const p of w.pickups) {
      const gx = Math.round((p.x - M.CONFIG.TILE / 2) / M.CONFIG.TILE);
      const gy = Math.round((p.y - M.CONFIG.TILE / 2) / M.CONFIG.TILE);
      assert.ok(seen.has(gx + "," + gy), `pickup reachable (${diff})`);
    }
    // entities remain finite after homing updates toward the player
    for (let f = 0; f < 120; f++) w.updateEntities(w.vip.x, w.vip.y);
    for (const e of w.entities) assert.ok(Number.isFinite(e.x) && Number.isFinite(e.y), "entity finite");
    mazes++;
  }
}
console.log(`maze.test.js OK — ${mazes} mazes, VIP + pickups reachable, entities stable`);
