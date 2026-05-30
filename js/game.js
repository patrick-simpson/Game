/* ============================================================
   game.js — Main loop, state management, windshield rendering,
   physics, collisions, laser / jump, and win-lose handling.
   ============================================================ */

window.MMR = window.MMR || {};
(function (M) {
  "use strict";

  const CFG = M.CONFIG;
  const U = M.U;

  class Game {
    constructor() {
      this.canvas = document.getElementById("view");
      this.ctx = this.canvas.getContext("2d");
      this.overlay = document.getElementById("overlay");

      this.dashboard = new M.Dashboard(this);

      // persistent state
      this.world = null;
      this.car = { x: 0, y: 0, angle: -Math.PI / 2 };
      this.steer = 0;
      this.steerHeld = false; // set true while wheel is dragged
      this.keyLeft = false;
      this.keyRight = false;

      this.speedMode = "STOP";
      this.shield = CFG.SHIELD_MAX;
      this.pedestrianHits = 0;

      this.running = false;
      this.state = "intro"; // intro | playing | won | lost

      this.hitCooldown = 0;
      this.jump = { active: false, timer: 0, cooldown: 0 };
      this.laser = { cooldown: 0, beam: null };
      this.explosions = [];
      this.shake = 0;

      this._bindKeys();
      this._bindOverlayButton();

      // continuous render of dashboard wheel even at intro
      this.lastTime = 0;
      requestAnimationFrame((t) => this._frame(t));
    }

    // ---------------- Setup / lifecycle ----------------
    _bindOverlayButton() {
      const startBtn = document.getElementById("start-btn");
      if (startBtn) startBtn.addEventListener("click", () => this.startNew());
    }

    startNew() {
      this.world = new M.World();
      const s = this.world.tileCenter(this.world.start.gx, this.world.start.gy);
      this.car.x = s.x;
      this.car.y = s.y;
      this.car.angle = -Math.PI / 2; // facing "up"/north
      this.steer = 0;
      this.speedMode = "STOP";
      this.shield = CFG.SHIELD_MAX;
      this.pedestrianHits = 0;
      this.hitCooldown = 0;
      this.jump = { active: false, timer: 0, cooldown: 0 };
      this.laser = { cooldown: 0, beam: null };
      this.explosions = [];
      this.shake = 0;
      this.state = "playing";
      this.running = true;
      this.dashboard.setActiveSpeed("STOP");
      this._hideOverlay();
    }

    _hideOverlay() { this.overlay.classList.remove("overlay-show"); }
    _showOverlay() { this.overlay.classList.add("overlay-show"); }

    // ---------------- Input ----------------
    _bindKeys() {
      window.addEventListener("keydown", (e) => {
        switch (e.key) {
          case "ArrowLeft": this.keyLeft = true; e.preventDefault(); break;
          case "ArrowRight": this.keyRight = true; e.preventDefault(); break;
          case "ArrowUp": this._shiftSpeed(1); e.preventDefault(); break;
          case "ArrowDown": this._shiftSpeed(-1); e.preventDefault(); break;
          case " ": case "Spacebar": this.fireLaser(); e.preventDefault(); break;
          case "j": case "J": case "Shift": this.doJump(); break;
          case "g": case "G": this.setSpeedMode("GO"); break;
          case "s": case "S": this.setSpeedMode("STOP"); break;
          case "f": case "F": this.setSpeedMode("FAST"); break;
          case "Enter":
            if (this.state === "won" || this.state === "lost" || this.state === "intro") this.startNew();
            break;
        }
      });
      window.addEventListener("keyup", (e) => {
        if (e.key === "ArrowLeft") this.keyLeft = false;
        if (e.key === "ArrowRight") this.keyRight = false;
      });
    }

    _shiftSpeed(dir) {
      const order = ["STOP", "SLOW", "GO", "FAST"];
      let i = order.indexOf(this.speedMode);
      i = U.clamp(i + dir, 0, order.length - 1);
      this.setSpeedMode(order[i]);
    }

    setSpeedMode(mode) {
      if (!(mode in CFG.SPEEDS)) return;
      this.speedMode = mode;
      this.dashboard.setActiveSpeed(mode);
    }

    // ---------------- Laser ----------------
    fireLaser() {
      if (this.state !== "playing") return;
      if (this.laser.cooldown > 0) return;
      this.laser.cooldown = CFG.LASER_COOLDOWN;
      this.dashboard.flashLaser();
      this.dashboard.setLaserCooldown(true);

      // determine beam length: stop at the first wall/obstacle tile
      const a = this.car.angle;
      const dx = Math.cos(a), dy = Math.sin(a);
      let len = CFG.LASER_RANGE;
      for (let d = 8; d <= CFG.LASER_RANGE; d += 6) {
        const px = this.car.x + dx * d;
        const py = this.car.y + dy * d;
        const gx = Math.floor(px / CFG.TILE), gy = Math.floor(py / CFG.TILE);
        if (this.world.isWallTile(gx, gy) || this.world.isObstacleAt(gx, gy)) { len = d; break; }
      }
      this.laser.beam = { x: this.car.x, y: this.car.y, a, len, life: 12 };

      // destroy hostiles along the beam (never pedestrians)
      for (const e of this.world.entities) {
        if (!e.alive || e.type === "pedestrian") continue;
        const rx = e.x - this.car.x, ry = e.y - this.car.y;
        const t = rx * dx + ry * dy;            // projection along beam
        if (t < 0 || t > len) continue;
        const perp = Math.abs(rx * dy - ry * dx); // perpendicular distance
        if (perp < 18) {
          e.alive = false;
          this._spawnExplosion(e.x, e.y, e.type === "driver" ? "#ff3b53" : "#ff7b2f");
        }
      }
    }

    // ---------------- Jump rocket ----------------
    doJump() {
      if (this.state !== "playing") return;
      if (this.jump.cooldown > 0 || this.jump.active) return;
      this.jump.active = true;
      this.jump.timer = CFG.JUMP_DURATION;
      this.jump.cooldown = CFG.JUMP_COOLDOWN;
      this.dashboard.flashJump();
      this.dashboard.setJumpCooldown(true);
    }

    // ---------------- Explosions ----------------
    _spawnExplosion(x, y, color) {
      const bits = [];
      for (let i = 0; i < 14; i++) {
        const ang = Math.random() * Math.PI * 2;
        const spd = 1 + Math.random() * 3.5;
        bits.push({
          x, y,
          vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
          size: 4 + U.rand(6)
        });
      }
      this.explosions.push({ x, y, color, timer: 26, max: 26, bits });
      this.shake = Math.min(this.shake + 6, 14);
    }

    // ---------------- Update ----------------
    _update() {
      if (this.state !== "playing") return;
      const car = this.car, w = this.world;

      // --- steering ---
      const turning = this.keyLeft || this.keyRight;
      if (this.keyLeft) this.steer = U.clamp(this.steer - 0.14, -1, 1);
      if (this.keyRight) this.steer = U.clamp(this.steer + 0.14, -1, 1);
      if (!turning && !this.steerHeld) this.steer *= 0.80;

      const speed = CFG.SPEEDS[this.speedMode];
      const turnFactor = speed > 0 ? 1 : 0.65;
      car.angle += this.steer * CFG.TURN_RATE * turnFactor;

      // --- movement with wall/obstacle collision (axis separated) ---
      if (speed > 0) {
        const dx = Math.cos(car.angle) * speed;
        const dy = Math.sin(car.angle) * speed;
        let crashed = false;

        const blocked = (px, py) => {
          const col = w.carCollision(px, py, CFG.CAR_RADIUS);
          if (!col) return false;
          if (col.kind === "wall") return true;
          if (col.kind === "obstacle") return !this.jump.active; // jump glides over
          return false;
        };

        if (!blocked(car.x + dx, car.y)) car.x += dx; else crashed = true;
        if (!blocked(car.x, car.y + dy)) car.y += dy; else crashed = true;

        if (crashed && this.hitCooldown === 0) {
          this._damage(CFG.WALL_HIT_DAMAGE);
          this.setSpeedMode("STOP"); // crashing stops the car
        }
      }

      // --- jump timers ---
      if (this.jump.active) {
        this.jump.timer--;
        if (this.jump.timer <= 0) this.jump.active = false;
      }
      if (this.jump.cooldown > 0) {
        this.jump.cooldown--;
        if (this.jump.cooldown === 0) this.dashboard.setJumpCooldown(false);
      }

      // --- laser timers ---
      if (this.laser.cooldown > 0) {
        this.laser.cooldown--;
        if (this.laser.cooldown === 0) this.dashboard.setLaserCooldown(false);
      }
      if (this.laser.beam) {
        this.laser.beam.life--;
        if (this.laser.beam.life <= 0) this.laser.beam = null;
      }

      // --- entities ---
      w.updateEntities();
      this._entityCollisions();

      // --- explosions ---
      for (const ex of this.explosions) {
        ex.timer--;
        for (const b of ex.bits) { b.x += b.vx; b.y += b.vy; b.vx *= 0.92; b.vy *= 0.92; }
      }
      this.explosions = this.explosions.filter((e) => e.timer > 0);

      if (this.shake > 0) this.shake *= 0.85;
      if (this.shake < 0.3) this.shake = 0;
      if (this.hitCooldown > 0) this.hitCooldown--;

      // --- win / lose ---
      if (U.dist(car.x, car.y, w.vip.x, w.vip.y) < CFG.VIP_REACH) this._win();
      if (this.shield <= 0) this._lose();

      // --- HUD ---
      this.dashboard.updateHud(this);
    }

    _damage(amount) {
      this.shield = Math.max(0, this.shield - amount);
      this.hitCooldown = CFG.HIT_COOLDOWN;
      this.shake = Math.min(this.shake + 8, 16);
    }

    _entityCollisions() {
      const car = this.car;
      for (const e of this.world.entities) {
        if (!e.alive) continue;
        if (e.cool > 0) { e.cool--; continue; }
        const er = e.type === "driver" ? 16 : e.type === "creature" ? 14 : 11;
        if (U.dist(car.x, car.y, e.x, e.y) < CFG.CAR_RADIUS + er) {
          if (e.type === "pedestrian") {
            // warning penalty — innocent bystander!
            this.pedestrianHits++;
            this.shield = Math.max(0, this.shield - 5);
            this.dashboard.flashWarning();
            e.cool = 50;
            // shove the pedestrian aside
            const ang = Math.atan2(e.y - car.y, e.x - car.x);
            e.x += Math.cos(ang) * 14;
            e.y += Math.sin(ang) * 14;
          } else if (this.hitCooldown === 0) {
            // hostile crash
            this._damage(CFG.HOSTILE_HIT_DAMAGE);
            this.setSpeedMode("STOP");
            e.cool = 30;
          }
        }
      }
    }

    _win() {
      if (this.state !== "playing") return;
      this.state = "won";
      this.running = false;
      this._renderEndCard(true);
    }
    _lose() {
      if (this.state !== "playing") return;
      this.state = "lost";
      this.running = false;
      this._renderEndCard(false);
    }

    _renderEndCard(won) {
      const card = this.overlay.querySelector(".overlay-card");
      if (won) {
        card.innerHTML = `
          <h1 class="overlay-title win">VIP RESCUED!</h1>
          <p class="overlay-sub">MISSION COMPLETE</p>
          <p class="overlay-text">You navigated the containment zone and reached the VIP.
            Shield remaining: <b>${Math.round(this.shield)}%</b> &nbsp;|&nbsp;
            Pedestrian hits: <b>${this.pedestrianHits}</b></p>
          <button id="again-btn" class="big-btn">PLAY AGAIN</button>`;
      } else {
        card.innerHTML = `
          <h1 class="overlay-title lose">CAR DESTROYED</h1>
          <p class="overlay-sub">MISSION FAILED</p>
          <p class="overlay-text">Your shield was depleted before reaching the VIP.
            The rescue target is still out there. Try a new route.</p>
          <button id="again-btn" class="big-btn">TRY AGAIN</button>`;
      }
      this._showOverlay();
      const btn = document.getElementById("again-btn");
      if (btn) btn.addEventListener("click", () => this.startNew());
    }

    // ---------------- Render ----------------
    _frame(t) {
      const dt = t - this.lastTime;
      this.lastTime = t;
      this._update();
      this._render();
      // wheel + minimap update every frame for smoothness
      this.dashboard.drawWheel(this.steer);
      if (this.world) this.dashboard.drawMinimap(this.world, this.car);
      requestAnimationFrame((tt) => this._frame(tt));
    }

    _render() {
      const ctx = this.ctx;
      const W = this.canvas.width, H = this.canvas.height;
      ctx.clearRect(0, 0, W, H);

      // backdrop
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, "#0a1830");
      bg.addColorStop(1, "#040810");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      if (!this.world) return;

      const car = this.car;
      const cx = W / 2;
      const cy = H * 0.62; // car sits lower so we see ahead

      const sxk = (Math.random() - 0.5) * this.shake;
      const syk = (Math.random() - 0.5) * this.shake;

      ctx.save();
      ctx.translate(cx + sxk, cy + syk);
      ctx.rotate(-(car.angle + Math.PI / 2)); // heading points up
      ctx.translate(-car.x, -car.y);

      this._renderWorld(ctx);

      ctx.restore();

      // car drawn at fixed center, pointing up
      this._renderCar(ctx, cx + sxk, cy + syk);

      // vignette
      const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.9);
      vg.addColorStop(0, "rgba(0,0,0,0)");
      vg.addColorStop(1, "rgba(0,0,0,0.55)");
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, W, H);
    }

    _renderWorld(ctx) {
      const w = this.world;
      const T = CFG.TILE;
      const car = this.car;
      const range = 9; // tiles around the car to draw
      const cgx = Math.floor(car.x / T), cgy = Math.floor(car.y / T);

      // floor + walls
      for (let gy = cgy - range; gy <= cgy + range; gy++) {
        for (let gx = cgx - range; gx <= cgx + range; gx++) {
          if (gx < 0 || gy < 0 || gx >= w.gw || gy >= w.gh) continue;
          const x = gx * T, y = gy * T;
          if (w.grid[gy][gx] === 1) {
            this._drawWall(ctx, x, y, T);
          } else {
            this._drawFloor(ctx, x, y, T);
          }
        }
      }

      // obstacles
      for (const o of w.obstacles) {
        const c = w.tileCenter(o.gx, o.gy);
        this._drawObstacle(ctx, c.x, c.y, o.type);
      }

      // VIP (visible in the world — find with your eyes!)
      w.vip.bob += 0.06;
      this._drawVip(ctx, w.vip.x, w.vip.y, w.vip.bob);

      // entities
      for (const e of w.entities) {
        if (!e.alive) continue;
        if (e.type === "pedestrian") this._drawPedestrian(ctx, e);
        else if (e.type === "creature") this._drawCreature(ctx, e);
        else this._drawDriver(ctx, e);
      }

      // laser beam
      if (this.laser.beam) this._drawBeam(ctx, this.laser.beam);

      // explosions
      for (const ex of this.explosions) this._drawExplosion(ctx, ex);
    }

    _drawFloor(ctx, x, y, T) {
      ctx.fillStyle = "#0c1626";
      ctx.fillRect(x, y, T, T);
      ctx.strokeStyle = "rgba(47,243,255,0.06)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, T - 1, T - 1);
    }

    _drawWall(ctx, x, y, T) {
      // glowing containment block with a faux-height top face
      const g = ctx.createLinearGradient(x, y, x, y + T);
      g.addColorStop(0, "#1b3a6b");
      g.addColorStop(1, "#0e2348");
      ctx.fillStyle = g;
      ctx.fillRect(x, y, T, T);
      // neon edge
      ctx.strokeStyle = "rgba(47,243,255,0.5)";
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, T - 2, T - 2);
      // inner highlight
      ctx.strokeStyle = "rgba(120,200,255,0.18)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 5, y + 5, T - 10, T - 10);
    }

    _drawObstacle(ctx, x, y, type) {
      ctx.save();
      ctx.translate(x, y);
      if (type === "block") {
        ctx.fillStyle = "#3a2c10";
        ctx.strokeStyle = "#ffb627";
        ctx.lineWidth = 3;
        const s = 20;
        ctx.fillRect(-s, -s, s * 2, s * 2);
        ctx.strokeRect(-s, -s, s * 2, s * 2);
        // hazard stripes
        ctx.strokeStyle = "rgba(255,182,39,0.6)";
        ctx.lineWidth = 4;
        for (let i = -s; i < s; i += 10) {
          ctx.beginPath(); ctx.moveTo(i, -s); ctx.lineTo(i + s, 0); ctx.stroke();
        }
      } else { // rail
        ctx.strokeStyle = "#ff7b2f";
        ctx.lineWidth = 6;
        ctx.shadowColor = "#ff7b2f";
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.moveTo(-22, -10); ctx.lineTo(22, -10);
        ctx.moveTo(-22, 10); ctx.lineTo(22, 10);
        ctx.stroke();
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(-14, -10); ctx.lineTo(-14, 10);
        ctx.moveTo(0, -10); ctx.lineTo(0, 10);
        ctx.moveTo(14, -10); ctx.lineTo(14, 10);
        ctx.stroke();
      }
      ctx.restore();
    }

    _drawVip(ctx, x, y, bob) {
      ctx.save();
      ctx.translate(x, y + Math.sin(bob) * 3);
      // pulsing rescue ring
      const pr = 22 + Math.sin(bob * 1.5) * 4;
      ctx.strokeStyle = "rgba(255,215,80,0.8)";
      ctx.lineWidth = 3;
      ctx.shadowColor = "#ffd750";
      ctx.shadowBlur = 18;
      ctx.beginPath(); ctx.arc(0, 0, pr, 0, Math.PI * 2); ctx.stroke();
      ctx.shadowBlur = 0;
      // figure
      ctx.fillStyle = "#ffe9a8";
      ctx.beginPath(); ctx.arc(0, -8, 6, 0, Math.PI * 2); ctx.fill(); // head
      ctx.fillStyle = "#ffd750";
      ctx.beginPath();
      ctx.moveTo(-7, 12); ctx.lineTo(0, -2); ctx.lineTo(7, 12); ctx.closePath();
      ctx.fill();
      // label
      ctx.fillStyle = "#fff";
      ctx.font = "bold 10px Consolas, monospace";
      ctx.textAlign = "center";
      ctx.fillText("VIP", 0, -20);
      ctx.restore();
    }

    _drawPedestrian(ctx, e) {
      ctx.save();
      ctx.translate(e.x, e.y);
      const sway = Math.sin(e.wobble) * 2;
      ctx.fillStyle = "#bdeaff";
      ctx.beginPath(); ctx.arc(sway, -6, 4, 0, Math.PI * 2); ctx.fill(); // head
      ctx.fillStyle = "#6f9fd0";
      ctx.beginPath();
      ctx.moveTo(-4 + sway, 8); ctx.lineTo(sway, -2); ctx.lineTo(4 + sway, 8);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    _drawCreature(ctx, e) {
      ctx.save();
      ctx.translate(e.x, e.y);
      ctx.rotate(e.wobble * 0.3);
      ctx.fillStyle = "#ff2bd6";
      ctx.shadowColor = "#ff2bd6";
      ctx.shadowBlur = 10;
      ctx.beginPath();
      const spikes = 7, R = 13, r = 7;
      for (let i = 0; i < spikes * 2; i++) {
        const rad = i % 2 === 0 ? R : r;
        const a = (i / (spikes * 2)) * Math.PI * 2;
        const px = Math.cos(a) * rad, py = Math.sin(a) * rad;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill();
      ctx.shadowBlur = 0;
      // eyes
      ctx.fillStyle = "#0a0010";
      ctx.beginPath(); ctx.arc(-3, -1, 2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(3, -1, 2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    _drawDriver(ctx, e) {
      ctx.save();
      ctx.translate(e.x, e.y);
      ctx.rotate(Math.atan2(e.vy, e.vx) + Math.PI / 2);
      // rogue red car
      ctx.fillStyle = "#ff3b53";
      ctx.strokeStyle = "#ffd6dc";
      ctx.lineWidth = 1.5;
      this._roundRect(ctx, -10, -15, 20, 30, 5);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#2a0008";
      this._roundRect(ctx, -7, -10, 14, 9, 3); ctx.fill(); // windshield
      ctx.fillStyle = "#ffd966";
      ctx.beginPath(); ctx.arc(-6, -14, 2, 0, Math.PI * 2);
      ctx.arc(6, -14, 2, 0, Math.PI * 2); ctx.fill(); // headlights
      ctx.restore();
    }

    _drawBeam(ctx, beam) {
      ctx.save();
      ctx.translate(beam.x, beam.y);
      ctx.rotate(beam.a);
      const alpha = beam.life / 12;
      ctx.globalAlpha = alpha;
      // core
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 4;
      ctx.shadowColor = "#ff2bd6";
      ctx.shadowBlur = 16;
      ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(beam.len, 0); ctx.stroke();
      // outer glow
      ctx.strokeStyle = "rgba(255,43,214,0.6)";
      ctx.lineWidth = 12;
      ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(beam.len, 0); ctx.stroke();
      ctx.restore();
    }

    _drawExplosion(ctx, ex) {
      const f = ex.timer / ex.max;
      ctx.save();
      // pixelated debris squares
      const palette = [ex.color, "#ffffff", "#ffb627", "#ffe9a8"];
      ex.bits.forEach((b, i) => {
        ctx.globalAlpha = f;
        ctx.fillStyle = palette[i % palette.length];
        const s = b.size * f + 1;
        ctx.fillRect(Math.round(b.x - s / 2), Math.round(b.y - s / 2), Math.ceil(s), Math.ceil(s));
      });
      // shock ring
      ctx.globalAlpha = f * 0.7;
      ctx.strokeStyle = ex.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(ex.x, ex.y, (1 - f) * 30 + 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    _renderCar(ctx, cx, cy) {
      const jumpScale = this.jump.active
        ? 1 + Math.sin((1 - this.jump.timer / CFG.JUMP_DURATION) * Math.PI) * 0.5
        : 1;

      ctx.save();
      ctx.translate(cx, cy);

      // jump shadow on the ground below
      if (this.jump.active) {
        const lift = (jumpScale - 1);
        ctx.save();
        ctx.globalAlpha = 0.35 - lift * 0.2;
        ctx.fillStyle = "#000";
        ctx.beginPath();
        ctx.ellipse(0, 22 + lift * 16, 16, 7, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      ctx.scale(jumpScale, jumpScale);

      // invuln flicker after a hit
      if (this.hitCooldown > 0 && Math.floor(this.hitCooldown / 4) % 2 === 0) {
        ctx.globalAlpha = 0.5;
      }

      // spy car body (points up)
      const grad = ctx.createLinearGradient(-16, 0, 16, 0);
      grad.addColorStop(0, "#1f6fb0");
      grad.addColorStop(0.5, "#3ad0ff");
      grad.addColorStop(1, "#1f6fb0");
      ctx.fillStyle = grad;
      ctx.strokeStyle = "#eafcff";
      ctx.lineWidth = 2;
      this._roundRect(ctx, -15, -22, 30, 44, 8);
      ctx.fill(); ctx.stroke();

      // windshield
      ctx.fillStyle = "#04263a";
      this._roundRect(ctx, -10, -16, 20, 12, 4);
      ctx.fill();

      // cockpit stripe
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      this._roundRect(ctx, -3, -20, 6, 40, 3);
      ctx.fill();

      // headlights (front = up)
      ctx.fillStyle = "#fff7c2";
      ctx.shadowColor = "#fff7c2"; ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(-9, -20, 2.5, 0, Math.PI * 2);
      ctx.arc(9, -20, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      // tail lights
      ctx.fillStyle = "#ff3b53";
      ctx.beginPath();
      ctx.arc(-9, 20, 2, 0, Math.PI * 2);
      ctx.arc(9, 20, 2, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }

    _roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }
  }

  // boot once DOM is ready
  function boot() { M.game = new Game(); }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(window.MMR);
