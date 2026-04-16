# Pixepolis

A voxel city simulator with citizens, economy, power, industrial zones, and optional multiplayer.

---

## Single-player (no install needed)

Just open `voxel_city.html` directly in your browser.

---

## Multiplayer (WebSocket server)

**Requirements:** Node.js 16+

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start
# or: node server.js

# 3. Open in browser
# http://localhost:3000
```

Open the same URL in multiple tabs or share it on your local network — all players share the same city.

---

## Controls

| Action | How |
|---|---|
| Orbit camera | Left-click drag |
| Zoom | Scroll wheel |
| Place tile | Select mode → click tile |
| Inspect tile | View mode → click tile |
| Upgrade building | View mode → click tile → Upgrade button |

## Build modes

| Button | Cost | Notes |
|---|---|---|
| Road | $1 | Required near Res/Ind before placing |
| Res | $5 | Needs adjacent road; spawns citizens |
| Com | $8 | Citizens shop here; receives goods from Ind |
| Ind | $10 | Needs adjacent road; trucks deliver goods to Com |
| Power | $15 | Diamond-radius coverage; buildings need it to earn income |

## Systems

- **Citizens** — walk Res→Com via A* (roads only), shop or work, carry wages home
- **Goods** — Ind produces → trucks deliver → Com stocks → citizens buy
- **Happiness** — affected by goods availability, employment, pollution, power; scales income
- **Land value** — scored per tile from roads/power/neighbours; gates upgrades
- **Demand bars** — R/C drift based on zone balance; affects growth speed and income
- **Organic growth** — buildings auto-upgrade over time when conditions are met

## Multiplayer notes

- Each player gets a unique colour shown in the HUD roster
- Tile placements, demolitions, and upgrades sync instantly to all clients
- Economy (money, citizens, happiness) runs independently per client
- The game works fully offline if the server isn't running
