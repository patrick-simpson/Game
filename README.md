# Ultra Maze Driver — Jungle Rescue: First-Person Drive

A fully client-side arcade rescue game. You sit **inside** a high-tech spy car:
the **windshield** (HTML5 Canvas) renders a first-person, pseudo-3D drive down a
jungle corridor (a raycaster), while the **dashboard** below gives you a working
steering wheel, speed controls, a laser, a jump rocket, and a tactical mini-map.

Follow the path and take the **right turns** to reach the lost **VIP** — dodging
aggressive rogue cars, hulking monsters, and innocent jungle explorers. Walls are
harmless (you just bump and slide); the one thing that ends a run is driving off a
wrong turn into the **void**, which sends you back to the start to try again.

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
| Lifetime stats | — | **★** button |
| Restart | `Enter` | **Play Again** |

On phones/tablets, on-screen **steer pads** and **GO / laser / jump / boost /
reverse** buttons appear automatically over the windshield; the wheel and
mini-map scale to the screen and the dashboard reflows for small/portrait
layouts.

### Goal

- Pick a **difficulty** (Easy / Normal / Hard), then drive the corridor toward
  the **VIP**, using your eyes, the mini-map, and the directional compass.
- The route is **mostly straight with a few decision turns**. Take the right
  turns to reach the VIP; wrong turns **loop back** to the path.
- **Do not drive into the VOID.** Wrong openings drop away into a dark pit — fall
  in and you simply **start over** at the beginning of the same run. (There is no
  shield and no health: walls are harmless, they just stop you.)
- **Laser** destroys rogue cars and monsters (never the human explorers).
- **Jump Rocket** hops the car over small obstacles (logs).
- **Nitro Boost** burns the boost meter for a burst of speed.
- Grab glowing green **gems** along the route for bonus points (optional).
- The mini-map shows walls, threats, gems, **void pits (red)**, your explored
  trail, and your blinking location — but it **never reveals the VIP**. A
  directional **rescue beacon** appears once you are close.

### Views, comfort & difficulty

The default view is **first-person** — a pseudo-3D raycaster that puts you behind
the windshield looking down the jungle path; cars, monsters, and people grow as
they approach and are hidden behind walls. You can switch to the **classic
top-down** view (and its optional rotating "cockpit" mode) from the pause menu.

The default difficulty is **Easy** (shortest, straightest route with the fewest
decoys). Normal and Hard have longer routes, more branches, and more void traps.
An always-on **compass** points toward the VIP without revealing the exact tile.

## Highlights

- **First-person pseudo-3D** jungle drive (raycaster) with textured foliage walls,
  a forest floor/canopy, billboard sprites, and a cockpit hood — plus a classic
  top-down view toggle.
- Realistic procedural sprites: aggressive **rogue cars**, hulking **monsters**,
  human **explorers**, and a human **VIP** (all drawn at runtime, no art files).
- **Guided-route** generator: a mostly-straight path with looping branches and
  deadly **void** traps; falling in restarts you at the start.
- Procedural Web Audio engine (no sound files) with a dynamic engine hum.
- Nitro boost, score gems, scoring, mission timer, and a saved best time.
- Auto-drive **DEMO** button that navigates the route for you.
- Pause menu with accessibility toggles: screen shake, reduced motion, mute,
  **high contrast + threat marks**, **larger text**, and **mobile vibration**.
- Full **touch controls** + responsive layout for phones and tablets.
- **Lifetime stats** (runs, rescues, best score, kills, gems, playtime) saved
  locally and shown on the intro and end screens, with a reset option.
- Performance-tuned rendering (cached gradients + pre-rendered textures/sprites,
  z-buffered billboards, fixed-timestep simulation) and high-DPI canvases.

## Project structure

```
index.html        Entry point / cabin layout
css/style.css     Arcade + neon dashboard styling
js/audio.js       Procedural Web Audio sound engine
js/maze.js        Maze generation, obstacles, drivers, creatures, pickups, VIP
js/dashboard.js   Steering wheel, buttons, cooldown meters, mini-map, HUD
js/game.js        Main loop, state, physics, particles, scoring, win/lose
test/             Headless Node tests (maze reachability + game smoke test)
package.json      `npm run check` (syntax) and `npm test` (test suite)
```

## Tests

No build step is required to play. To run the headless checks:

```
npm run check   # node --check on all four JS modules
npm test        # maze reachability + DOM/Canvas-mocked game smoke test
```

## Deploy to GitHub Pages

1. Push this repository to GitHub.
2. In **Settings → Pages**, set the source to your branch (root).
3. Visit the published URL — the game runs entirely in the browser.
