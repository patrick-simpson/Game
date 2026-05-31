/* ============================================================
   maze.js — Maze generation, obstacles, pedestrians,
   creatures, rogue drivers, shield pickups, and the VIP.
   Supports difficulty presets and light enemy homing AI.
   (Improvements #3, #5, #6)
   ============================================================ */

window.MMR = window.MMR || {};
(function (M) {
  "use strict";

  // ---- Global tuning constants (shared across modules) ----
  const CONFIG = {
    TILE: 64,
    CAR_RADIUS: 15,
    // Fix #8: rebalanced speeds for finer control (lower top speed)
    SPEEDS: { STOP: 0, SLOW: 1.3, GO: 2.3, FAST: 3.6 },
    REVERSE_SPEED: 1.6,   // Fix #6: reverse gear
    BOOST_MULT: 1.7,
    TURN_RATE: 0.055,
    SHIELD_MAX: 100,
    // Fix #3: much gentler damage
    WALL_HIT_DAMAGE: 5,
    HOSTILE_HIT_DAMAGE: 11,
    HIT_COOLDOWN: 60,     // Fix #16: longer invulnerability after a hit
    START_GRACE: 150,     // Fix #13: spawn protection frames
    SHIELD_REGEN: 0.05,   // Fix #5: shield auto-regen per frame
    REGEN_DELAY: 150,     // frames of no damage before regen kicks in
    LASER_RANGE: 360,
    LASER_COOLDOWN: 26,
    JUMP_DURATION: 42,
    JUMP_COOLDOWN: 70,
    VIP_REACH: 44,        // Fix #12: forgiving arrival radius
    SHIELD_PICKUP: 34,
    BEACON_RANGE: 8       // ping range in cells
  };
  M.CONFIG = CONFIG;

  // ---- Difficulty presets (rebalanced for playability) ----
  // Fix #9, #10, #14, #15, #19: gentler enemies, smaller mazes, more pickups.
  // `straight` biases the carver to keep going in the same direction so
  // corridors run long between turns; `loops` is the fraction of extra wall
  // openings punched in to remove dead-ends (higher = easier to navigate).
  const DIFFICULTY = {
    EASY:   { cols: 9,  rows: 9,  pedestrians: 4, creatures: 2, drivers: 2, obstacles: 5,  pickups: 5, enemyScale: 0.7,  homing: 0.0,  reveal: true,  straight: 0.85, loops: 0.16 },
    NORMAL: { cols: 12, rows: 12, pedestrians: 6, creatures: 4, drivers: 3, obstacles: 8,  pickups: 4, enemyScale: 0.9,  homing: 0.15, reveal: false, straight: 0.72, loops: 0.12 },
    HARD:   { cols: 15, rows: 15, pedestrians: 8, creatures: 6, drivers: 5, obstacles: 12, pickups: 3, enemyScale: 1.15, homing: 0.4,  reveal: false, straight: 0.58, loops: 0.09 }
  };
  M.DIFFICULTY = DIFFICULTY;

  const U = {
    rand: (n) => Math.floor(Math.random() * n),
    dist: (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by),
    clamp: (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v),
    pick: (arr) => arr[Math.floor(Math.random() * arr.length)]
  };
  M.U = U;

  class World {
    constructor(diffName) {
      const d = DIFFICULTY[diffName] || DIFFICULTY.NORMAL;
      this.diff = d;
      this.cols = d.cols;
      this.rows = d.rows;
      this.gw = this.cols * 2 + 1;
      this.gh = this.rows * 2 + 1;
      this.grid = [];
      this.obstacles = [];
      this.entities = [];
      this.pickups = [];
      this.vip = null;
      this.start = null;
      this._generate();
      this._placeObstacles();
      this._spawnEntities();
      this._placeVip();
      this._placePickups();
    }

    get pixelW() { return this.gw * CONFIG.TILE; }
    get pixelH() { return this.gh * CONFIG.TILE; }

    inBounds(gx, gy) { return gx >= 0 && gy >= 0 && gx < this.gw && gy < this.gh; }

    isWallTile(gx, gy) {
      if (!this.inBounds(gx, gy)) return true;
      return this.grid[gy][gx] === 1;
    }

    _generate() {
      const { gw, gh } = this;
      for (let y = 0; y < gh; y++) this.grid.push(new Array(gw).fill(1));
      const visited = [];
      for (let y = 0; y < this.rows; y++) visited.push(new Array(this.cols).fill(false));

      const cellToGrid = (cx, cy) => [cx * 2 + 1, cy * 2 + 1];
      const stack = [];
      let cx = 0, cy = 0;
      visited[cy][cx] = true;
      const [sgx, sgy] = cellToGrid(cx, cy);
      this.grid[sgy][sgx] = 0;
      stack.push([cx, cy]);

      const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
      const straight = this.diff.straight !== undefined ? this.diff.straight : 0.7;
      let lastDir = null; // direction of the most recent carve
      while (stack.length) {
        [cx, cy] = stack[stack.length - 1];
        const opts = [];
        for (const [dx, dy] of DIRS) {
          const nx = cx + dx, ny = cy + dy;
          if (nx >= 0 && ny >= 0 && nx < this.cols && ny < this.rows && !visited[ny][nx]) {
            opts.push([nx, ny, dx, dy]);
          }
        }
        if (!opts.length) { stack.pop(); lastDir = null; continue; }
        // Straight bias: keep heading the same way when possible so corridors
        // run long between turns; otherwise pick a random new direction.
        let choice = null;
        if (lastDir && Math.random() < straight) {
          choice = opts.find((o) => o[2] === lastDir[0] && o[3] === lastDir[1]) || null;
        }
        if (!choice) choice = U.pick(opts);
        const [nx, ny, dx, dy] = choice;
        const [cgx, cgy] = cellToGrid(cx, cy);
        this.grid[cgy + dy][cgx + dx] = 0;
        this.grid[cgy + dy * 2][cgx + dx * 2] = 0;
        visited[ny][nx] = true;
        lastDir = [dx, dy];
        stack.push([nx, ny]);
      }

      const extra = Math.floor((this.cols * this.rows) * (this.diff.loops !== undefined ? this.diff.loops : 0.08));
      for (let i = 0; i < extra; i++) {
        const wx = 1 + U.rand(this.gw - 2);
        const wy = 1 + U.rand(this.gh - 2);
        if (this.grid[wy][wx] === 1) {
          const horiz = this.grid[wy][wx - 1] === 0 && this.grid[wy][wx + 1] === 0;
          const vert = this.grid[wy - 1] && this.grid[wy + 1] &&
                       this.grid[wy - 1][wx] === 0 && this.grid[wy + 1][wx] === 0;
          if (horiz || vert) this.grid[wy][wx] = 0;
        }
      }
      this.start = { gx: 1, gy: 1 };
    }

    tileCenter(gx, gy) {
      return { x: gx * CONFIG.TILE + CONFIG.TILE / 2, y: gy * CONFIG.TILE + CONFIG.TILE / 2 };
    }

    _openCells() {
      const cells = [];
      for (let cy = 0; cy < this.rows; cy++)
        for (let cx = 0; cx < this.cols; cx++)
          cells.push({ gx: cx * 2 + 1, gy: cy * 2 + 1 });
      return cells;
    }

    _placeObstacles() {
      const cells = this._openCells().filter(
        (c) => !(c.gx === this.start.gx && c.gy === this.start.gy)
      );
      cells.sort(() => Math.random() - 0.5);
      const count = Math.min(this.diff.obstacles, cells.length);
      for (let i = 0; i < count; i++) {
        const c = cells[i];
        this.obstacles.push({ gx: c.gx, gy: c.gy, type: Math.random() < 0.5 ? "block" : "rail" });
      }
    }

    isObstacleAt(gx, gy) {
      return this.obstacles.find((o) => o.gx === gx && o.gy === gy) || null;
    }

    _spawnEntities() {
      const cells = this._openCells().filter((c) => {
        if (c.gx === this.start.gx && c.gy === this.start.gy) return false;
        return Math.abs(c.gx - this.start.gx) + Math.abs(c.gy - this.start.gy) > 3;
      });
      cells.sort(() => Math.random() - 0.5);
      const scale = this.diff.enemyScale;

      const make = (type, speed) => {
        const c = cells.pop();
        if (!c) return;
        const ctr = this.tileCenter(c.gx, c.gy);
        const ang = Math.random() * Math.PI * 2;
        this.entities.push({
          type, x: ctr.x, y: ctr.y,
          vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
          speed, alive: true, cool: 0,
          wobble: Math.random() * Math.PI * 2, retarget: U.rand(120)
        });
      };

      for (let i = 0; i < this.diff.pedestrians; i++) make("pedestrian", 0.5);
      for (let i = 0; i < this.diff.creatures; i++) make("creature", 0.8 * scale);
      for (let i = 0; i < this.diff.drivers; i++) make("driver", 1.5 * scale);
    }

    // Fix #15: VIP is far from start but NOT jammed into the single worst
    // corner — pick randomly among the farthest open cells so routes vary
    // and aren't always maximally punishing.
    _placeVip() {
      const cells = this._openCells().filter((c) => !this.isObstacleAt(c.gx, c.gy));
      cells.forEach((c) => {
        c._d = Math.abs(c.gx - this.start.gx) + Math.abs(c.gy - this.start.gy);
      });
      cells.sort((a, b) => b._d - a._d);
      const pool = cells.slice(0, Math.max(1, Math.ceil(cells.length * 0.22)));
      const best = U.pick(pool);
      const ctr = this.tileCenter(best.gx, best.gy);
      this.vip = { x: ctr.x, y: ctr.y, gx: best.gx, gy: best.gy, bob: 0 };
    }

    // Shield repair cells (Improvement #5)
    _placePickups() {
      const taken = new Set([
        this.start.gx + "," + this.start.gy,
        this.vip.gx + "," + this.vip.gy
      ]);
      this.obstacles.forEach((o) => taken.add(o.gx + "," + o.gy));
      const cells = this._openCells().filter((c) => {
        if (taken.has(c.gx + "," + c.gy)) return false;
        return Math.abs(c.gx - this.start.gx) + Math.abs(c.gy - this.start.gy) > 4;
      });
      cells.sort(() => Math.random() - 0.5);
      for (let i = 0; i < Math.min(this.diff.pickups, cells.length); i++) {
        const ctr = this.tileCenter(cells[i].gx, cells[i].gy);
        this.pickups.push({ x: ctr.x, y: ctr.y, taken: false, bob: Math.random() * Math.PI * 2 });
      }
    }

    // Entities wander. Hostiles lightly home toward the player (gentle,
    // short-range). Pedestrians actively steer AWAY from the car so the
    // player is far less likely to clip an innocent. (Fix #4, #9)
    updateEntities(px, py) {
      const homing = this.diff.homing;
      for (const e of this.entities) {
        if (!e.alive) continue;
        e.wobble += 0.08;

        e.retarget--;
        if (e.retarget <= 0) {
          const ang = Math.random() * Math.PI * 2;
          e.vx = Math.cos(ang) * e.speed;
          e.vy = Math.sin(ang) * e.speed;
          e.retarget = 80 + U.rand(160);
        }

        if (px !== undefined) {
          const d = U.dist(e.x, e.y, px, py);
          if (e.type === "pedestrian") {
            // flee the car when it gets close
            if (d < CONFIG.TILE * 2.2 && d > 1) {
              const ax = (e.x - px) / d, ay = (e.y - py) / d;
              e.vx += ax * e.speed * 0.5;
              e.vy += ay * e.speed * 0.5;
              const sp = Math.hypot(e.vx, e.vy) || 1;
              e.vx = (e.vx / sp) * e.speed;
              e.vy = (e.vy / sp) * e.speed;
            }
          } else if (homing > 0 && d < CONFIG.TILE * 3.5 && d > 1) {
            // gentle, shorter-range homing for hostiles
            const hx = (px - e.x) / d, hy = (py - e.y) / d;
            const k = homing * (e.type === "driver" ? 1 : 0.6);
            e.vx += hx * e.speed * k * 0.08;
            e.vy += hy * e.speed * k * 0.08;
            const sp = Math.hypot(e.vx, e.vy) || 1;
            e.vx = (e.vx / sp) * e.speed;
            e.vy = (e.vy / sp) * e.speed;
          }
        }

        const r = 10;
        const nx = e.x + e.vx, ny = e.y + e.vy;
        if (!this._pointBlocked(nx + Math.sign(e.vx) * r, e.y)) e.x = nx; else e.vx = -e.vx;
        if (!this._pointBlocked(e.x, ny + Math.sign(e.vy) * r)) e.y = ny; else e.vy = -e.vy;
      }
    }

    _pointBlocked(px, py) {
      const T = CONFIG.TILE;
      return this.isWallTile(Math.floor(px / T), Math.floor(py / T));
    }

    carCollision(px, py, radius) {
      const T = CONFIG.TILE;
      const samples = [
        [px, py],
        [px + radius, py], [px - radius, py],
        [px, py + radius], [px, py - radius],
        [px + radius * 0.7, py + radius * 0.7], [px - radius * 0.7, py + radius * 0.7],
        [px + radius * 0.7, py - radius * 0.7], [px - radius * 0.7, py - radius * 0.7]
      ];
      let hitObstacle = null;
      for (const [sx, sy] of samples) {
        const gx = Math.floor(sx / T), gy = Math.floor(sy / T);
        if (this.isWallTile(gx, gy)) {
          const ob = this.isObstacleAt(gx, gy);
          if (ob) { hitObstacle = ob; continue; }
          return { kind: "wall" };
        }
        const ob = this.isObstacleAt(gx, gy);
        if (ob) {
          const c = this.tileCenter(gx, gy);
          if (U.dist(sx, sy, c.x, c.y) < T * 0.35 + 2) hitObstacle = ob;
        }
      }
      if (hitObstacle) return { kind: "obstacle", obstacle: hitObstacle };
      return null;
    }
  }

  M.World = World;
})(window.MMR);
