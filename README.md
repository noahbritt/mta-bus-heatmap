# MTA Bus Heatmap

Live animated heatmap of every active MTA bus in New York City.

![NYC Bus Heatmap](https://img.shields.io/badge/buses-live-ff6b35)

## Features

- **Live heatmap** of all active MTA buses, updating every 30s
- **Dot view** with color-coding by route, occupancy, or speed
- **Borough & route filtering**
- **Click hot zones** to see which routes contribute to density
- **Stats dashboard** — total buses, busiest route, moving vs stationary, occupancy breakdown
- **Timelapse playback** — record a full day and play it back at 1x–360x speed
- **Pulse mode** — breathing heatmap effect synced to bus density
- **Demo mode** — works without an API key using realistic simulated data

## Quick Start

```bash
npm install
npm start
```

Open http://localhost:3000.

The app starts in **demo mode** with simulated bus data. To use live MTA data:

1. Register for a free API key at https://register.developer.obanyc.com (takes ~30 min)
2. Get a Mapbox token at https://mapbox.com (free tier works)
3. Edit `.env`:

```
MTA_API_KEY=your_key_here
MAPBOX_TOKEN=your_token_here
```

4. Restart the server

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

- **Server**: Node.js + Express + WebSocket. Polls MTA BusTime SIRI API, broadcasts to clients, records to SQLite.
- **Client**: Vanilla JS with Deck.gl (HeatmapLayer, ScatterplotLayer) over Mapbox GL JS.
- **Storage**: SQLite via better-sqlite3. Auto-cleans data older than 7 days.

## API Notes

- MTA bearing convention: 0 = East, counter-clockwise. The server converts to standard (0 = North, clockwise).
- Stale vehicle positions (>5 min old) are filtered out.
- `ProgressRate: noProgress` = stationary bus.
