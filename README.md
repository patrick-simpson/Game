# Ultra Maze Driver — Mega Maze Rescue: Dashboard Simulator

A fully client-side arcade rescue game. You sit inside a high-tech spy car: the
**windshield** (HTML5 Canvas) shows a scrolling driving view of a giant
containment-zone maze, while the **dashboard** below gives you a working
steering wheel, speed controls, a laser, a jump rocket, and a tactical mini-map.

Find the **VIP** hidden deep in the maze and drive up to them to win — while
dodging walls, rogue drivers, dangerous creatures, and innocent pedestrians.

## Play

Open `index.html` in any modern browser, or deploy to GitHub Pages (below).
No backend or build step is required.

### Controls

| Action | Keyboard | Dashboard |
| --- | --- | --- |
| Steer | `←` / `→` | Drag the steering wheel |
| Faster / Slower | `↑` / `↓` | **GO / FAST / SLOW / STOP** buttons |
| Quick Go / Stop / Fast | `G` / `S` / `F` | — |
| Reverse | `R` (hold) | **REVERSE** button (hold) |
| Fire Laser | `Space` | **LASER** button |
| Jump Rocket | `J` / `Shift` | **JUMP** button |
| Nitro Boost | `B` (hold) | **BOOST** button |
| Pause / Settings | `P` / `Esc` | **❚❚** button |
| Mute | `M` | **🔊** button |
| Toggle help strip | `H` | **?** button |
| Restart | `Enter` | **Play Again** |

### Goal

- Pick a **difficulty** (Easy / Normal / Hard), then navigate the procedurally
  generated maze using your eyes, the mini-map, and the proximity beacon.
- **Laser** destroys rogue drivers and dangerous creatures (never pedestrians).
- **Jump Rocket** glides the car over small obstacles (blocks & rails).
- **Nitro Boost** burns the boost meter for a burst of speed.
- Grab glowing **shield cells** to repair your shield.
- Crashing into walls or hostiles drains your **shield** and stops the car.
- Hitting innocent pedestrians triggers a warning penalty.
- The mini-map shows the maze walls, threats, repair cells, your explored
  trail, and your blinking location — but it **never reveals the VIP**. A
  directional **rescue beacon** only appears once you are close. Reach the VIP
  to complete the rescue and beat your best time.

### Comfort & difficulty

The camera is **north-up and stable** by default (the maze no longer spins
around you) — you can switch to the harder rotating "cockpit" view in the
pause menu. The default difficulty is **Easy**, the shield slowly regenerates
when you avoid damage, crashing only bumps you (it never force-stops the car),
pedestrians dodge out of your way, and an always-on **compass** points toward
the VIP without revealing the exact tile.

## Highlights

- Procedural Web Audio engine (no sound files) with a dynamic engine hum.
- Three difficulty presets with smarter, lightly homing enemy drivers.
- Nitro boost, shield pickups, scoring, mission timer, and a saved best time.
- Exhaust trails, speed lines, pixel explosions, damage flash, and win fireworks.
- Pause menu with accessibility toggles (screen shake, reduced motion, mute),
  high-DPI rendering, and a viewport-aware tactical mini-map.

## Project structure

```
index.html        Entry point / cabin layout
css/style.css     Arcade + neon dashboard styling
js/audio.js       Procedural Web Audio sound engine
js/maze.js        Maze generation, obstacles, drivers, creatures, pickups, VIP
js/dashboard.js   Steering wheel, buttons, cooldown meters, mini-map, HUD
js/game.js        Main loop, state, physics, particles, scoring, win/lose
```

## Deploy to GitHub Pages

1. Push this repository to GitHub.
2. In **Settings → Pages**, set the source to your branch (root).
3. Visit the published URL — the game runs entirely in the browser.
