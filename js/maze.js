/* ============================================================
   maze.js — Guided-route generator for the jungle rescue run.

   Instead of a dense maze, we carve a mostly-STRAIGHT main route
   from the start to the VIP with a handful of decision turns.
   Off that route we add:
     • looping branches — wrong turns that wind back to the route,
     • void branches    — short corridors that open onto a VOID
                           (grid value 2). Driving into a void is
                           the ONLY way to fail: it restarts you.
   Walls are harmless (you just bump/slide); there is no shield.
   Also spawns pedestrians (humans), creatures (monsters), rogue
   drivers (cars), score gems, light obstacles, and the VIP.
   ============================================================ */

window.MMR = window.MMR || {};
(function (M) {
  "use strict";

  // ---- Global tuning constants (shared across modules) ----
  const CONFIG = {
    TILE: 64,
    CAR_RADIUS: 15,
    SPEEDS: { STOP: 0, SLOW: 1.3, GO: 2.3, FAST: 3.6 },
    REVERSE_SPEED: 1.6,
    BOOST_MULT: 1.7,
    TURN_RATE: 0.055,
    HIT_COOLDOWN: 60,     // brief invulnerability after an enemy bump
    START_GRACE: 90,      // spawn protection frames
    LASER_RANGE: 360,
    LASER_COOLDOWN: 26,
    JUMP_DURATION: 42,
    JUMP_COOLDOWN: 70,
    VIP_REACH: 46,        // forgiving arrival radius
    GEM_PICKUP: 22,       // score-gem grab radius
    BEACON_RANGE: 8       // ping range in cells
  };
  M.CONFIG = CONFIG;

  // ---- Difficulty presets ----
  // routeLen  — target number of cells in the main start→VIP route
  // branches  — how many side branches to attach (loops + voids)
  // voids     — how many of those branches end in a deadly void
  // straight  — carver's bias to keep heading the same way (long corridors)
  const DIFFICULTY = {
    EASY:   { cols: 12, rows: 12, routeLen: 15, branches: 3, voids: 2, pedestrians: 3, creatures: 2, drivers: 2, obstacles: 3, pickups: 5, enemyScale: 0.7,  homing: 0.0,  reveal: true,  straight: 0.88 },
    NORMAL: { cols: 14, rows: 14, routeLen: 22, branches: 5, voids: 3, pedestrians: 5, creatures: 4, drivers: 3, obstacles: 5, pickups: 5, enemyScale: 0.9,  homing: 0.12, reveal: false, straight: 0.78 },
    HARD:   { cols: 16, rows: 16, routeLen: 30, branches: 7, voids: 5, pedestrians: 7, creatures: 6, drivers: 5, obstacles: 8, pickups: 5, enemyScale: 1.1,  homing: 0.3,  reveal: false, straight: 0.70 }
  };
  M.DIFFICULTY = DIFFICULTY;

  const U = {
    rand: (n) => Math.floor(Math.random() * n),
    dist: (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by),
    clamp: (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v),
    pick: (arr) => arr[Math.floor(Math.random() * arr.length)],
    shuffle: (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = U.rand(i + 1); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; } return arr; }
  };
  M.U = U;

  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

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
      this.voids = [];
      this.route = [];
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
    _inCell(cx, cy) { return cx >= 0 && cy >= 0 && cx < this.cols && cy < this.rows; }

    // grid value 1 = wall (blocks the car). Void (2) and floor (0) are drivable.
    isWallTile(gx, gy) {
      if (!this.inBounds(gx, gy)) return true;
      return this.grid[gy][gx] === 1;
    }
    // a VOID cell: open to drive into, but falling in restarts the run.
    isVoid(gx, gy) {
      if (!this.inBounds(gx, gy)) return false;
      return this.grid[gy][gx] === 2;
    }

    tileCenter(gx, gy) {
      return { x: gx * CONFIG.TILE + CONFIG.TILE / 2, y: gy * CONFIG.TILE + CONFIG.TILE / 2 };
    }

    // ---- generation ----
    _generate() {
      // best of several attempts: keep the longest main route so the VIP
      // sits a good distance from the start.
      let best = null;
      for (let attempt = 0; attempt < 40; attempt++) {
        const r = this._carveRoute();
        if (!best || r.route.length > best.route.length) best = r;
        if (best.route.length >= this.diff.routeLen) break;
      }
      this.grid = best.grid;
      this.route = best.route;
      this.visited = best.visited;
      this.start = { gx: 1, gy: 1 };
      this._addBranches();
    }

    _cellToGrid(cx, cy) { return [cx * 2 + 1, cy * 2 + 1]; }

    _carveRoute() {
      const grid = [];
      for (let y = 0; y < this.gh; y++) grid.push(new Array(this.gw).fill(1));
      const visited = [];
      for (let y = 0; y < this.rows; y++) visited.push(new Array(this.cols).fill(false));

      const carve = (gx, gy) => { grid[gy][gx] = 0; };
      const carveBetween = (ax, ay, bx, by) => {
        const [agx, agy] = this._cellToGrid(ax, ay);
        const [bgx, bgy] = this._cellToGrid(bx, by);
        carve(agx, agy); carve(bgx, bgy);
        carve((agx + bgx) / 2, (agy + bgy) / 2);
      };

      let cx = 0, cy = 0;
      visited[cy][cx] = true;
      const [sgx, sgy] = this._cellToGrid(cx, cy);
      carve(sgx, sgy);
      const route = [[cx, cy]];
      let lastDir = null;
      const straight = this.diff.straight;
      const distFromStart = (x, y) => x + y; // start at (0,0); larger = farther

      while (route.length < this.diff.routeLen) {
        const opts = [];
        for (const [dx, dy] of DIRS) {
          const nx = cx + dx, ny = cy + dy;
          if (this._inCell(nx, ny) && !visited[ny][nx]) opts.push([dx, dy]);
        }
        if (!opts.length) break;

        let choice = null;
        if (lastDir && Math.random() < straight) {
          choice = opts.find((o) => o[0] === lastDir[0] && o[1] === lastDir[1]) || null;
        }
        if (!choice) {
          // otherwise prefer turns that push us farther from the start
          opts.sort((a, b) =>
            distFromStart(cx + b[0], cy + b[1]) - distFromStart(cx + a[0], cy + a[1]));
          choice = Math.random() < 0.6 ? opts[0] : U.pick(opts);
        }
        const nx = cx + choice[0], ny = cy + choice[1];
        carveBetween(cx, cy, nx, ny);
        visited[ny][nx] = true;
        lastDir = choice;
        cx = nx; cy = ny;
        route.push([cx, cy]);
      }
      return { grid, visited, route };
    }

    // Attach looping + void branches at a few route junctions.
    _addBranches() {
      const grid = this.grid, visited = this.visited;
      const carve = (gx, gy) => { grid[gy][gx] = 0; };
      const carveBetween = (ax, ay, bx, by) => {
        const [agx, agy] = this._cellToGrid(ax, ay);
        const [bgx, bgy] = this._cellToGrid(bx, by);
        carve(agx, agy); carve(bgx, bgy);
        carve((agx + bgx) / 2, (agy + bgy) / 2);
      };
      const perp = (dx, dy) => (dx !== 0 ? [0, Math.random() < 0.5 ? -1 : 1] : [Math.random() < 0.5 ? -1 : 1, 0]);

      // candidate junctions: route cells away from both ends
      const junctions = U.shuffle(this.route.slice(2, Math.max(3, this.route.length - 2)));
      let made = 0, voidsLeft = this.diff.voids;
      const want = this.diff.branches;

      for (const [jx, jy] of junctions) {
        if (made >= want) break;
        const dirs = U.shuffle(DIRS.filter(([dx, dy]) => {
          const nx = jx + dx, ny = jy + dy;
          return this._inCell(nx, ny) && !visited[ny][nx];
        }));
        if (!dirs.length) continue;

        // place the required voids first, then loops
        const type = voidsLeft > 0 ? "void" : "loop";
        if (this._carveBranch(jx, jy, dirs[0], type, visited, carveBetween, perp)) {
          made++;
          if (type === "void") voidsLeft--;
        }
      }
    }

    _carveBranch(jx, jy, dir, type, visited, carveBetween, perp) {
      let [dx, dy] = dir;
      let cx = jx, cy = jy;
      const len = 2 + U.rand(2); // 2–3 cells
      let carved = 0;
      for (let i = 0; i < len; i++) {
        const nx = cx + dx, ny = cy + dy;
        if (!this._inCell(nx, ny) || visited[ny][nx]) break;
        carveBetween(cx, cy, nx, ny);
        visited[ny][nx] = true;
        cx = nx; cy = ny; carved++;

        // looping branch: try to reconnect to an already-open FLOOR neighbour
        // (never a void — that would carve the hazard back to solid ground)
        if (type === "loop" && i >= 1) {
          for (const [ex, ey] of U.shuffle(DIRS.slice())) {
            const ax = cx + ex, ay = cy + ey;
            if (ax === cx - dx && ay === cy - dy) continue; // not back the way we came
            if (!this._inCell(ax, ay) || !visited[ay][ax]) continue;
            const [agx, agy] = this._cellToGrid(ax, ay);
            if (this.grid[agy][agx] !== 0) continue; // skip voids / non-floor
            carveBetween(cx, cy, ax, ay);
            return true;
          }
        }
        if (Math.random() < 0.4) { const nd = perp(dx, dy); dx = nd[0]; dy = nd[1]; }
      }
      if (carved === 0) return false;
      if (type === "void") {
        const [vgx, vgy] = this._cellToGrid(cx, cy);
        this.grid[vgy][vgx] = 2;
        this.voids.push({ gx: vgx, gy: vgy });
      }
      return true;
    }

    // open FLOOR cells (grid === 0); excludes walls and voids
    _openCells() {
      const cells = [];
      for (let cy = 0; cy < this.rows; cy++) {
        for (let cx = 0; cx < this.cols; cx++) {
          const gx = cx * 2 + 1, gy = cy * 2 + 1;
          if (this.grid[gy][gx] === 0) cells.push({ gx, gy });
        }
      }
      return cells;
    }

    _placeObstacles() {
      const cells = this._openCells().filter(
        (c) => !(c.gx === this.start.gx && c.gy === this.start.gy)
      );
      U.shuffle(cells);
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
      U.shuffle(cells);
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

    // VIP waits at the far end of the main route.
    _placeVip() {
      const end = this.route[this.route.length - 1] || [0, 0];
      const [gx, gy] = this._cellToGrid(end[0], end[1]);
      const ctr = this.tileCenter(gx, gy);
      this.vip = { x: ctr.x, y: ctr.y, gx, gy, bob: 0 };
    }

    // Score gems sprinkled along the route (optional bonus pickups).
    _placePickups() {
      const taken = new Set([
        this.start.gx + "," + this.start.gy,
        this.vip.gx + "," + this.vip.gy
      ]);
      this.obstacles.forEach((o) => taken.add(o.gx + "," + o.gy));
      // prefer route cells so gems sit on the path you actually drive
      const routeCells = this.route
        .map(([cx, cy]) => { const [gx, gy] = this._cellToGrid(cx, cy); return { gx, gy }; })
        .filter((c) => !taken.has(c.gx + "," + c.gy) &&
          Math.abs(c.gx - this.start.gx) + Math.abs(c.gy - this.start.gy) > 3);
      U.shuffle(routeCells);
      for (let i = 0; i < Math.min(this.diff.pickups, routeCells.length); i++) {
        const ctr = this.tileCenter(routeCells[i].gx, routeCells[i].gy);
        this.pickups.push({ x: ctr.x, y: ctr.y, taken: false, bob: Math.random() * Math.PI * 2 });
      }
    }

    // Entities wander. Hostiles lightly home toward the player; pedestrians
    // flee. Everything bounces off walls AND voids (only the player can fall).
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
            if (d < CONFIG.TILE * 2.2 && d > 1) {
              const ax = (e.x - px) / d, ay = (e.y - py) / d;
              e.vx += ax * e.speed * 0.5;
              e.vy += ay * e.speed * 0.5;
              const sp = Math.hypot(e.vx, e.vy) || 1;
              e.vx = (e.vx / sp) * e.speed;
              e.vy = (e.vy / sp) * e.speed;
            }
          } else if (homing > 0 && d < CONFIG.TILE * 3.5 && d > 1) {
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

    // entities are blocked by walls and by voids (they never fall in)
    _pointBlocked(px, py) {
      const T = CONFIG.TILE;
      const gx = Math.floor(px / T), gy = Math.floor(py / T);
      return this.isWallTile(gx, gy) || this.isVoid(gx, gy);
    }

    // The car only collides with walls/obstacles; voids are drivable (and fatal,
    // handled by the game loop). Returns {kind:"wall"} or {kind:"obstacle",...}.
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
