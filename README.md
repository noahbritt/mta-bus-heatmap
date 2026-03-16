# MTA Bus Heatmap

Live animated heatmap of every active MTA bus in New York City.

![NYC Bus Heatmap](https://img.shields.io/badge/buses-live-ff6b35)

## Features

- **Live bus map** of all active MTA buses, updating every 30s
- **Dot view** with color-coding by route, occupancy, or speed
- **Heatmap view** to visualize bus density across the city
- **Borough & route filtering**
- **Click hot zones** to see which routes contribute to density
- **Stats dashboard** — total buses, busiest route, moving vs stationary, occupancy breakdown
- **Timelapse playback** — record a full day and play it back at 1x-360x speed
- **Pulse mode** — breathing heatmap effect synced to bus density
- **Demo mode** — works without an API key using simulated data

## Quick Start

```bash
npm install
npm start
```

Open http://localhost:3000.

The app starts in **demo mode** with simulated bus data. To use live MTA data:

1. Register for a free API key at https://register.developer.obanyc.com
2. Edit `.env`:

```
MTA_API_KEY=your_key_here
```

3. Restart the server

## Controls

| Control | Description |
|---|---|
| Heatmap / Buses | Toggle between heatmap and individual bus dots |
| Color By | In bus mode: color by route, occupancy, or speed |
| Borough | Filter to Manhattan, Brooklyn, Queens, Bronx, or Staten Island |
| Route | Search or select a specific bus route |
| Live / Timelapse | Switch between live data and recorded playback |
| Pulse Mode | Adds a breathing animation to the heatmap |

## Timelapse

The server records every poll to SQLite. Switch to Timelapse mode, select a recorded day, and use the play/scrub controls. Speed options: 1x, 10x, 60x, 360x.

## Architecture

- **Server**: Node.js + Express + WebSocket. Polls the MTA GTFS-RT Vehicle Positions feed, broadcasts to clients, records to SQLite.
- **Client**: Vanilla JS with Leaflet + CartoDB dark tiles + leaflet-heat.
- **Storage**: SQLite via better-sqlite3. Auto-cleans data older than 7 days.

## API Notes

- Uses the GTFS-RT Vehicle Positions feed (bulk-friendly, protobuf format).
- Stale vehicle positions (>5 min old) are filtered out.
- Polls every 30 seconds to respect MTA rate limits.
