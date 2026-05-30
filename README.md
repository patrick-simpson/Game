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
| Quick Go / Stop | `G` / `S` | — |
| Fire Laser | `Space` | **LASER** button |
| Jump Rocket | `J` / `Shift` | **JUMP ROCKET** button |
| Restart | `Enter` | **Play Again** |

### Goal

- Navigate the procedurally generated maze using your eyes and the mini-map.
- **Laser** destroys rogue drivers and dangerous creatures (never pedestrians).
- **Jump Rocket** glides the car over small obstacles (blocks & rails).
- Crashing into walls or hostiles drains your **shield** and stops the car.
- Hitting innocent pedestrians triggers a warning penalty.
- The mini-map shows the maze walls, threats, and your blinking location —
  but it **never reveals the VIP**. Reach the VIP to complete the rescue.

## Project structure

```
index.html        Entry point / cabin layout
css/style.css     Arcade + neon dashboard styling
js/maze.js        Maze generation, obstacles, drivers, creatures, VIP
js/dashboard.js   Steering wheel, buttons, mini-map, HUD
js/game.js        Main loop, state, physics, rendering, win/lose
```

## Deploy to GitHub Pages

1. Push this repository to GitHub.
2. In **Settings → Pages**, set the source to your branch (root).
3. Visit the published URL — the game runs entirely in the browser.
