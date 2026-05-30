/* ============================================================
   dashboard.js — Steering wheel, speed/action buttons, and the
   tactical mini-map. Wires physical dashboard controls to the
   game instance passed in at construction.
   ============================================================ */

window.MMR = window.MMR || {};
(function (M) {
  "use strict";

  const U = M.U;
  const MAX_WHEEL = Math.PI * 0.72; // visual rotation at full steer

  class Dashboard {
    constructor(game) {
      this.game = game;

      // --- Canvases ---
      this.wheel = document.getElementById("wheel");
      this.wctx = this.wheel.getContext("2d");
      this.minimap = document.getElementById("minimap");
      this.mctx = this.minimap.getContext("2d");

      // --- Buttons ---
      this.speedBtns = Array.from(document.querySelectorAll(".speed-btn"));
      this.laserBtn = document.getElementById("laser-btn");
      this.jumpBtn = document.getElementById("jump-btn");

      // --- HUD elements ---
      this.shieldFill = document.getElementById("shield-fill");
      this.speedReadout = document.getElementById("speed-readout");
      this.distReadout = document.getElementById("dist-readout");
      this.warnReadout = document.getElementById("warn-readout");
      this.warnPill = document.getElementById("warn-pill");
      this.headingVal = document.getElementById("heading-val");

      this._dragging = false;
      this._grabAngle = 0;
      this._grabSteer = 0;
      this._blink = 0;

      this._wireButtons();
      this._wireWheel();
    }

    // -------- Button wiring --------
    _wireButtons() {
      this.speedBtns.forEach((b) => {
        b.addEventListener("click", () => this.game.setSpeedMode(b.dataset.speed));
      });
      this.laserBtn.addEventListener("click", () => this.game.fireLaser());
      this.jumpBtn.addEventListener("click", () => this.game.doJump());
    }

    setActiveSpeed(mode) {
      this.speedBtns.forEach((b) => b.classList.toggle("active", b.dataset.speed === mode));
      this.speedReadout.textContent = mode;
    }

    flashLaser() {
      this.laserBtn.classList.add("fire");
      setTimeout(() => this.laserBtn.classList.remove("fire"), 160);
    }
    flashJump() {
      this.jumpBtn.classList.add("fire");
      setTimeout(() => this.jumpBtn.classList.remove("fire"), 220);
    }
    setLaserCooldown(on) { this.laserBtn.classList.toggle("cooldown", on); }
    setJumpCooldown(on) { this.jumpBtn.classList.toggle("cooldown", on); }

    // -------- Steering wheel drag --------
    _wireWheel() {
      const pointerAngle = (ev) => {
        const r = this.wheel.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const p = ev.touches ? ev.touches[0] : ev;
        return Math.atan2(p.clientY - cy, p.clientX - cx);
      };

      const down = (ev) => {
        this._dragging = true;
        this.wheel.classList.add("grabbing");
        this._grabAngle = pointerAngle(ev);
        this._grabSteer = this.game.steer;
        ev.preventDefault();
      };
      const move = (ev) => {
        if (!this._dragging) return;
        const delta = pointerAngle(ev) - this._grabAngle;
        const steer = U.clamp(this._grabSteer + delta / MAX_WHEEL, -1, 1);
        this.game.steer = steer;
        this.game.steerHeld = true; // prevent auto-return while held
        ev.preventDefault();
      };
      const up = () => {
        if (!this._dragging) return;
        this._dragging = false;
        this.wheel.classList.remove("grabbing");
        this.game.steerHeld = false;
      };

      this.wheel.addEventListener("mousedown", down);
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      this.wheel.addEventListener("touchstart", down, { passive: false });
      window.addEventListener("touchmove", move, { passive: false });
      window.addEventListener("touchend", up);
    }

    // -------- HUD render --------
    updateHud(game) {
      const pct = U.clamp(game.shield / M.CONFIG.SHIELD_MAX, 0, 1);
      this.shieldFill.style.width = (pct * 100) + "%";
      this.shieldFill.style.background =
        pct > 0.5 ? "linear-gradient(90deg,#39ff88,#2ff3ff)"
        : pct > 0.25 ? "linear-gradient(90deg,#ffb627,#ff7b2f)"
        : "linear-gradient(90deg,#ff3b53,#ff7b2f)";

      this.warnReadout.textContent = game.pedestrianHits;

      // distance to VIP (a coarse tracker — never the exact position)
      if (game.world && game.world.vip) {
        const d = U.dist(game.car.x, game.car.y, game.world.vip.x, game.world.vip.y);
        this.distReadout.textContent = Math.round(d / M.CONFIG.TILE) + " blk";
      }

      // heading compass letter
      this.headingVal.textContent = this._compass(game.car.angle);
    }

    flashWarning() {
      this.warnPill.classList.remove("flash");
      // force reflow to restart the animation
      void this.warnPill.offsetWidth;
      this.warnPill.classList.add("flash");
    }

    _compass(angle) {
      // angle: 0 = +x (east). Convert to compass with up = north.
      let deg = (angle * 180 / Math.PI) % 360;
      if (deg < 0) deg += 360;
      const names = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"];
      return names[Math.round(deg / 45) % 8];
    }

    // -------- Steering wheel render --------
    drawWheel(steer) {
      const ctx = this.wctx;
      const w = this.wheel.width, h = this.wheel.height;
      const cx = w / 2, cy = h / 2;
      const R = 92;
      ctx.clearRect(0, 0, w, h);

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(steer * MAX_WHEEL);

      // outer rim
      ctx.lineWidth = 18;
      ctx.strokeStyle = "#10203a";
      ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();

      ctx.lineWidth = 10;
      const rimGrad = ctx.createLinearGradient(-R, -R, R, R);
      rimGrad.addColorStop(0, "#3df0ff");
      rimGrad.addColorStop(0.5, "#1b9fd8");
      rimGrad.addColorStop(1, "#2ff3ff");
      ctx.strokeStyle = rimGrad;
      ctx.shadowColor = "rgba(47,243,255,0.7)";
      ctx.shadowBlur = 14;
      ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
      ctx.shadowBlur = 0;

      // spokes
      const spoke = (ang) => {
        ctx.save();
        ctx.rotate(ang);
        ctx.fillStyle = "#22304f";
        ctx.strokeStyle = "#3df0ff";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(-9, 0); ctx.lineTo(9, 0);
        ctx.lineTo(6, R - 12); ctx.lineTo(-6, R - 12);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.restore();
      };
      spoke(0);
      spoke(Math.PI * 2 / 3);
      spoke(-Math.PI * 2 / 3);

      // top marker (so rotation is obvious)
      ctx.save();
      ctx.fillStyle = "#ff2bd6";
      ctx.shadowColor = "#ff2bd6";
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.moveTo(0, -R - 2);
      ctx.lineTo(-8, -R + 14);
      ctx.lineTo(8, -R + 14);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // hub
      const hub = ctx.createRadialGradient(0, -6, 4, 0, 0, 34);
      hub.addColorStop(0, "#39507e");
      hub.addColorStop(1, "#0c1426");
      ctx.fillStyle = hub;
      ctx.beginPath(); ctx.arc(0, 0, 30, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#3df0ff"; ctx.lineWidth = 2; ctx.stroke();

      // hub emblem
      ctx.fillStyle = "#2ff3ff";
      ctx.font = "bold 13px Consolas, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("UMD", 0, 0);

      ctx.restore();
    }

    // -------- Mini-map render --------
    // Shows the maze walls + the blinking player dot + roaming
    // threats. The VIP location is intentionally NOT plotted.
    drawMinimap(world, car) {
      const ctx = this.mctx;
      const w = this.minimap.width, h = this.minimap.height;
      ctx.clearRect(0, 0, w, h);

      // dark CRT background
      ctx.fillStyle = "#021410";
      ctx.fillRect(0, 0, w, h);

      const sx = w / world.gw;
      const sy = h / world.gh;

      // walls
      ctx.fillStyle = "rgba(47,243,255,0.55)";
      for (let gy = 0; gy < world.gh; gy++) {
        for (let gx = 0; gx < world.gw; gx++) {
          if (world.grid[gy][gx] === 1) {
            ctx.fillRect(gx * sx, gy * sy, Math.ceil(sx), Math.ceil(sy));
          }
        }
      }

      // obstacles (faint amber)
      ctx.fillStyle = "rgba(255,182,39,0.6)";
      for (const o of world.obstacles) {
        ctx.fillRect(o.gx * sx + sx * 0.2, o.gy * sy + sy * 0.2, sx * 0.6, sy * 0.6);
      }

      // threats: drivers & creatures (NOT pedestrians, NOT the VIP)
      this._blink = (this._blink + 1) % 60;
      for (const e of world.entities) {
        if (!e.alive) continue;
        if (e.type === "pedestrian") continue;
        const mx = (e.x / world.pixelW) * w;
        const my = (e.y / world.pixelH) * h;
        ctx.fillStyle = e.type === "driver" ? "rgba(255,59,83,0.9)" : "rgba(255,120,60,0.8)";
        ctx.beginPath();
        ctx.arc(mx, my, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }

      // player blinking dot
      const px = (car.x / world.pixelW) * w;
      const py = (car.y / world.pixelH) * h;
      const on = this._blink < 38;
      if (on) {
        ctx.fillStyle = "#2ff3ff";
        ctx.shadowColor = "#2ff3ff";
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      // heading tick on player
      ctx.strokeStyle = "#eafcff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + Math.cos(car.angle) * 7, py + Math.sin(car.angle) * 7);
      ctx.stroke();
    }
  }

  M.Dashboard = Dashboard;
})(window.MMR);
