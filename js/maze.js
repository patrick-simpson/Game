/* ============================================================
   maze.js — Maze generation, obstacles, pedestrians,
   creatures, rogue drivers, and the VIP rescue target.
   Exposes everything on the shared global namespace `MMR`.
   ============================================================ */

window.MMR = window.MMR || {};
(function (M) {
  "use strict";

  // ---- Global tuning constants (shared across modules) ----
  const CONFIG = {
    TILE: 64,            // pixel size of one wall-grid tile
    CELLS_X: 13,         // maze cell columns
    CELLS_Y: 13,         // maze cell rows
    CAR_RADIUS: 16,
    SPEEDS: { STOP: 0, SLOW: 1.4, GO: 2.8, FAST: 4.8 },
    TURN_RATE: 0.052,    // radians per frame at full steer
    SHIELD_MAX: 100,
    WALL_HIT_DAMAGE: 16,
    HOSTILE_HIT_DAMAGE: 22,
    HIT_COOLDOWN: 45,    // frames of invulnerability after a hit
    PEDESTRIANS: 7,
    CREATURES: 6,
    DRIVERS: 5,
    OBSTACLES: 10,
    LASER_RANGE: 360,
    LASER_COOLDOWN: 26,
    JUMP_DURATION: 42,
    JUMP_COOLDOWN: 70,
    VIP_REACH: 30        // distance to VIP that counts as a rescue
  };
  M.CONFIG = CONFIG;

  // Small helper utilities reused everywhere
  const U = {
    rand: (n) => Math.floor(Math.random() * n),
    dist: (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by),
    clamp: (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v),
    pick: (arr) => arr[Math.floor(Math.random() * arr.length)]
  };
  M.U = U;

  // ------------------------------------------------------------
  //  World: holds the maze grid + all moving/static entities.
  // ------------------------------------------------------------
  class World {
    constructor() {
      this.cols = CONFIG.CELLS_X;
      this.rows = CONFIG.CELLS_Y;
      // Wall grid: (2*cols+1) x (2*rows+1). 1 = wall, 0 = open.
      this.gw = this.cols * 2 + 1;
      this.gh = this.rows * 2 + 1;
      this.grid = [];
      this.obstacles = [];   // {gx, gy, type:'block'|'rail'} in wall-grid coords
      this.entities = [];    // pedestrians, creatures, drivers
      this.vip = null;       // {x, y, gx, gy}
      this.start = null;     // {gx, gy}
      this._generate();
      this._placeObstacles();
      this._spawnEntities();
      this._placeVip();
    }

    // Pixel size of the whole world
    get pixelW() { return this.gw * CONFIG.TILE; }
    get pixelH() { return this.gh * CONFIG.TILE; }

    inBounds(gx, gy) { return gx >= 0 && gy >= 0 && gx < this.gw && gy < this.gh; }

    // Is the given wall-grid tile a wall?
    isWallTile(gx, gy) {
      if (!this.inBounds(gx, gy)) return true; // out of bounds = solid
      return this.grid[gy][gx] === 1;
    }

    // ---- Recursive-backtracker maze carving ----
    _generate() {
      const { gw, gh } = this;
      // Start fully walled.
      for (let y = 0; y < gh; y++) {
        const row = new Array(gw).fill(1);
        this.grid.push(row);
      }
      const visited = [];
      for (let y = 0; y < this.rows; y++) visited.push(new Array(this.cols).fill(false));

      const cellToGrid = (cx, cy) => [cx * 2 + 1, cy * 2 + 1];
      const stack = [];
      let cx = 0, cy = 0;
      visited[cy][cx] = true;
      let [sgx, sgy] = cellToGrid(cx, cy);
      this.grid[sgy][sgx] = 0;
      stack.push([cx, cy]);

      const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
      while (stack.length) {
        [cx, cy] = stack[stack.length - 1];
        // gather unvisited neighbours
        const opts = [];
        for (const [dx, dy] of DIRS) {
          const nx = cx + dx, ny = cy + dy;
          if (nx >= 0 && ny >= 0 && nx < this.cols && ny < this.rows && !visited[ny][nx]) {
            opts.push([nx, ny, dx, dy]);
          }
        }
        if (!opts.length) { stack.pop(); continue; }
        const [nx, ny, dx, dy] = U.pick(opts);
        // carve wall between current and neighbour
        const [cgx, cgy] = cellToGrid(cx, cy);
        this.grid[cgy + dy][cgx + dx] = 0;       // the wall between
        this.grid[cgy + dy * 2][cgx + dx * 2] = 0; // neighbour cell
        visited[ny][nx] = true;
        stack.push([nx, ny]);
      }

      // Punch a few random extra openings so the maze has loops
      // (makes the rescue feel less linear and traps less common).
      const extra = Math.floor((this.cols * this.rows) * 0.08);
      for (let i = 0; i < extra; i++) {
        const wx = 1 + U.rand(this.gw - 2);
        const wy = 1 + U.rand(this.gh - 2);
        // only knock out a wall that sits between two open cells
        if (this.grid[wy][wx] === 1) {
          const horiz = this.grid[wy][wx - 1] === 0 && this.grid[wy][wx + 1] === 0;
          const vert = this.grid[wy - 1] && this.grid[wy + 1] &&
                       this.grid[wy - 1][wx] === 0 && this.grid[wy + 1][wx] === 0;
          if (horiz || vert) this.grid[wy][wx] = 0;
        }
      }

      this.start = { gx: 1, gy: 1 };
    }

    // Pixel center of a wall-grid tile
    tileCenter(gx, gy) {
      return { x: gx * CONFIG.TILE + CONFIG.TILE / 2, y: gy * CONFIG.TILE + CONFIG.TILE / 2 };
    }

    // List of open (non-wall) cell tiles (odd,odd coordinates)
    _openCells() {
      const cells = [];
      for (let cy = 0; cy < this.rows; cy++) {
        for (let cx = 0; cx < this.cols; cx++) {
          cells.push({ gx: cx * 2 + 1, gy: cy * 2 + 1 });
        }
      }
      return cells;
    }

    // ---- Static jumpable obstacles (blocks & rails) ----
    _placeObstacles() {
      const cells = this._openCells().filter(
        (c) => !(c.gx === this.start.gx && c.gy === this.start.gy)
      );
      // shuffle
      cells.sort(() => Math.random() - 0.5);
      const count = Math.min(CONFIG.OBSTACLES, cells.length);
      for (let i = 0; i < count; i++) {
        const c = cells[i];
        const type = Math.random() < 0.5 ? "block" : "rail";
        this.obstacles.push({ gx: c.gx, gy: c.gy, type });
      }
    }

    isObstacleAt(gx, gy) {
      return this.obstacles.find((o) => o.gx === gx && o.gy === gy) || null;
    }

    // ---- Moving entities ----
    _spawnEntities() {
      const cells = this._openCells().filter((c) => {
        if (c.gx === this.start.gx && c.gy === this.start.gy) return false;
        // keep a little breathing room around spawn
        return Math.abs(c.gx - this.start.gx) + Math.abs(c.gy - this.start.gy) > 3;
      });
      cells.sort(() => Math.random() - 0.5);

      const make = (type, speed) => {
        const c = cells.pop();
        if (!c) return;
        const ctr = this.tileCenter(c.gx, c.gy);
        const ang = Math.random() * Math.PI * 2;
        this.entities.push({
          type,
          x: ctr.x, y: ctr.y,
          vx: Math.cos(ang) * speed,
          vy: Math.sin(ang) * speed,
          speed,
          alive: true,
          wobble: Math.random() * Math.PI * 2,
          retarget: U.rand(120)
        });
      };

      for (let i = 0; i < CONFIG.PEDESTRIANS; i++) make("pedestrian", 0.55);
      for (let i = 0; i < CONFIG.CREATURES; i++) make("creature", 0.9);
      for (let i = 0; i < CONFIG.DRIVERS; i++) make("driver", 1.9);
    }

    // ---- The VIP, hidden deep in a far corner ----
    _placeVip() {
      const cells = this._openCells();
      // Choose the open cell furthest (Manhattan) from start, biased to corners.
      let best = null, bestScore = -1;
      for (const c of cells) {
        const d = Math.abs(c.gx - this.start.gx) + Math.abs(c.gy - this.start.gy);
        // prefer cells near the far corner
        const cornerBias = (c.gx + c.gy);
        const score = d + cornerBias * 0.4;
        if (score > bestScore && !this.isObstacleAt(c.gx, c.gy)) {
          bestScore = score; best = c;
        }
      }
      const ctr = this.tileCenter(best.gx, best.gy);
      this.vip = { x: ctr.x, y: ctr.y, gx: best.gx, gy: best.gy, bob: 0 };
    }

    // ------------------------------------------------------------
    //  Entity movement. Entities wander the corridors, bouncing
    //  off walls. Drivers move faster and turn more aggressively.
    // ------------------------------------------------------------
    updateEntities() {
      const T = CONFIG.TILE;
      for (const e of this.entities) {
        if (!e.alive) continue;
        e.wobble += 0.08;

        // occasionally pick a fresh random heading
        e.retarget--;
        if (e.retarget <= 0) {
          const ang = Math.random() * Math.PI * 2;
          e.vx = Math.cos(ang) * e.speed;
          e.vy = Math.sin(ang) * e.speed;
          e.retarget = 80 + U.rand(160);
        }

        const tryMove = (nx, ny) => !this._pointBlocked(nx, ny);

        let nx = e.x + e.vx;
        let ny = e.y + e.vy;
        const r = 10;
        // axis-separated movement so they slide along walls
        if (tryMove(nx + Math.sign(e.vx) * r, e.y)) {
          e.x = nx;
        } else {
          e.vx = -e.vx; // bounce
        }
        if (tryMove(e.x, ny + Math.sign(e.vy) * r)) {
          e.y = ny;
        } else {
          e.vy = -e.vy;
        }
      }
    }

    // Is a pixel point inside a wall tile?
    _pointBlocked(px, py) {
      const T = CONFIG.TILE;
      const gx = Math.floor(px / T);
      const gy = Math.floor(py / T);
      return this.isWallTile(gx, gy);
    }

    // ------------------------------------------------------------
    //  Collision test for the player car against walls + obstacles.
    //  Returns one of: null | 'wall' | 'obstacle'
    //  (obstacles only block when the car is NOT jumping)
    // ------------------------------------------------------------
    carCollision(px, py, radius) {
      const T = CONFIG.TILE;
      // sample the car circle at several points
      const samples = [
        [px, py],
        [px + radius, py], [px - radius, py],
        [px, py + radius], [px, py - radius],
        [px + radius * 0.7, py + radius * 0.7],
        [px - radius * 0.7, py + radius * 0.7],
        [px + radius * 0.7, py - radius * 0.7],
        [px - radius * 0.7, py - radius * 0.7]
      ];
      let hitObstacle = null;
      for (const [sx, sy] of samples) {
        const gx = Math.floor(sx / T);
        const gy = Math.floor(sy / T);
        if (this.isWallTile(gx, gy)) {
          const ob = this.isObstacleAt(gx, gy);
          if (ob) { hitObstacle = ob; continue; }
          return { kind: "wall" };
        }
        const ob = this.isObstacleAt(gx, gy);
        if (ob) {
          // obstacle sits inside an open cell; collide with its inner box
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
