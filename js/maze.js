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
    CAR_RADIUS: 16,
    SPEEDS: { STOP: 0, SLOW: 1.4, GO: 2.8, FAST: 4.8 },
    BOOST_MULT: 1.7,
    TURN_RATE: 0.052,
    SHIELD_MAX: 100,
    WALL_HIT_DAMAGE: 16,
    HOSTILE_HIT_DAMAGE: 22,
    HIT_COOLDOWN: 45,
    LASER_RANGE: 360,
    LASER_COOLDOWN: 26,
    JUMP_DURATION: 42,
    JUMP_COOLDOWN: 70,
    VIP_REACH: 30,
    SHIELD_PICKUP: 28,    // shield restored per repair cell
    BEACON_RANGE: 6       // in cells: how close before the rescue beacon appears
  };
  M.CONFIG = CONFIG;

  // ---- Difficulty presets (Improvement #3) ----
  const DIFFICULTY = {
    EASY:   { cols: 11, rows: 11, pedestrians: 4, creatures: 3, drivers: 3, obstacles: 7,  pickups: 4, enemyScale: 0.8,  homing: 0.0  },
    NORMAL: { cols: 13, rows: 13, pedestrians: 7, creatures: 6, drivers: 5, obstacles: 10, pickups: 3, enemyScale: 1.0,  homing: 0.35 },
    HARD:   { cols: 17, rows: 17, pedestrians: 9, creatures: 8, drivers: 7, obstacles: 14, pickups: 2, enemyScale: 1.25, homing: 0.6  }
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
      while (stack.length) {
        [cx, cy] = stack[stack.length - 1];
        const opts = [];
        for (const [dx, dy] of DIRS) {
          const nx = cx + dx, ny = cy + dy;
          if (nx >= 0 && ny >= 0 && nx < this.cols && ny < this.rows && !visited[ny][nx]) {
            opts.push([nx, ny, dx, dy]);
          }
        }
        if (!opts.length) { stack.pop(); continue; }
        const [nx, ny, dx, dy] = U.pick(opts);
        const [cgx, cgy] = cellToGrid(cx, cy);
        this.grid[cgy + dy][cgx + dx] = 0;
        this.grid[cgy + dy * 2][cgx + dx * 2] = 0;
        visited[ny][nx] = true;
        stack.push([nx, ny]);
      }

      const extra = Math.floor((this.cols * this.rows) * 0.08);
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

      for (let i = 0; i < this.diff.pedestrians; i++) make("pedestrian", 0.55);
      for (let i = 0; i < this.diff.creatures; i++) make("creature", 0.9 * scale);
      for (let i = 0; i < this.diff.drivers; i++) make("driver", 1.9 * scale);
    }

    _placeVip() {
      const cells = this._openCells();
      let best = null, bestScore = -1;
      for (const c of cells) {
        const dd = Math.abs(c.gx - this.start.gx) + Math.abs(c.gy - this.start.gy);
        const score = dd + (c.gx + c.gy) * 0.4;
        if (score > bestScore && !this.isObstacleAt(c.gx, c.gy)) { bestScore = score; best = c; }
      }
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

    // Entities wander; drivers/creatures lightly home toward the player
    // when within line-of-corridor range (Improvement #6).
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

        // homing nudge for hostiles
        if (homing > 0 && e.type !== "pedestrian" && px !== undefined) {
          const d = U.dist(e.x, e.y, px, py);
          if (d < CONFIG.TILE * 5 && d > 1) {
            const hx = (px - e.x) / d, hy = (py - e.y) / d;
            const k = homing * (e.type === "driver" ? 1 : 0.6);
            e.vx += hx * e.speed * k * 0.12;
            e.vy += hy * e.speed * k * 0.12;
            // clamp to its speed
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
