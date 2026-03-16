require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const { saveSnapshot, cleanOldData } = require('./db');
const routes = require('./routes');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const MTA_API_KEY = process.env.MTA_API_KEY;
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS) || 30000;

if (!MTA_API_KEY || MTA_API_KEY === 'your_mta_api_key_here') {
  console.warn('WARNING: MTA_API_KEY not set. The app will serve the UI but bus data will use demo mode.');
}

// Serve static files
app.use(express.static(path.join(__dirname, '..', 'client')));

// Provide mapbox token to client (without exposing .env)
app.get('/api/config', (req, res) => {
  res.json({
    mapboxToken: MAPBOX_TOKEN || '',
    pollInterval: POLL_INTERVAL,
    demoMode: !MTA_API_KEY || MTA_API_KEY === 'your_mta_api_key_here',
  });
});

app.use(routes);

// ---- MTA API Polling ----

let latestVehicles = [];
let previousVehicles = [];
let lastPollTime = null;

async function fetchAllVehicles() {
  if (!MTA_API_KEY || MTA_API_KEY === 'your_mta_api_key_here') {
    return generateDemoData();
  }

  // Use GTFS-RT Vehicle Positions feed (designed for bulk fetching, unlike SIRI)
  const url = `https://gtfsrt.prod.obanyc.com/vehiclePositions?key=${MTA_API_KEY}`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error(`GTFS-RT error: ${resp.status} ${resp.statusText}`);
      return null;
    }
    const buffer = await resp.arrayBuffer();
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

    const now = Date.now();
    const vehicles = [];

    for (const entity of feed.entity) {
      const vp = entity.vehicle;
      if (!vp || !vp.position) continue;

      // Filter stale data (older than 5 minutes)
      const timestamp = vp.timestamp ? Number(vp.timestamp) * 1000 : now;
      if (now - timestamp > 5 * 60 * 1000) continue;

      // Extract route name from trip or route descriptor
      const routeId = vp.trip?.routeId || '';
      // routeId format: "MTA NYCT_B63" — extract the short name after underscore
      const publishedLineName = routeId.includes('_') ? routeId.split('_').pop() : routeId;

      vehicles.push({
        vehicleRef: vp.vehicle?.id || entity.id || null,
        lineRef: routeId || null,
        publishedLineName: publishedLineName || null,
        directionRef: vp.trip?.directionId != null ? String(vp.trip.directionId) : null,
        destination: null,  // GTFS-RT doesn't include destination in vehicle positions
        latitude: vp.position.latitude,
        longitude: vp.position.longitude,
        // GTFS-RT bearing is standard (0=North, clockwise) — no conversion needed
        bearing: vp.position.bearing || null,
        // GTFS-RT currentStatus: STOPPED_AT (1), IN_TRANSIT_TO (2)
        progressRate: vp.currentStatus === 1 ? 'noProgress' : 'normalProgress',
        progressStatus: null,
        occupancy: parseOccupancy(vp.occupancyStatus),
        recordedAt: new Date(timestamp).toISOString(),
      });
    }

    console.log(`GTFS-RT: ${vehicles.length} active vehicles from ${feed.entity.length} entities`);
    return vehicles;
  } catch (err) {
    console.error('Error fetching GTFS-RT data:', err.message);
    return null;
  }
}

function parseOccupancy(status) {
  // GTFS-RT OccupancyStatus enum
  if (status == null) return null;
  switch (status) {
    case 0: return 'seatsAvailable';       // EMPTY
    case 1: return 'seatsAvailable';       // MANY_SEATS_AVAILABLE
    case 2: return 'seatsAvailable';       // FEW_SEATS_AVAILABLE
    case 3: return 'standingAvailable';    // STANDING_ROOM_ONLY
    case 4: return 'full';                 // CRUSHED_STANDING_ROOM_ONLY
    case 5: return 'full';                 // FULL
    case 6: return 'full';                 // NOT_ACCEPTING_PASSENGERS
    default: return null;
  }
}

// Demo data generator for when no API key is set
function generateDemoData() {
  const routes = [
    'B63', 'B61', 'B67', 'B69', 'B41', 'B44', 'B45', 'B46', 'B47', 'B48',
    'M1', 'M2', 'M3', 'M4', 'M5', 'M7', 'M10', 'M14', 'M15', 'M20',
    'M31', 'M34', 'M42', 'M50', 'M57', 'M60', 'M66', 'M72', 'M79', 'M86',
    'M96', 'M101', 'M102', 'M103', 'M104', 'M106',
    'Bx1', 'Bx2', 'Bx3', 'Bx4', 'Bx5', 'Bx6', 'Bx7', 'Bx9', 'Bx10', 'Bx11',
    'Bx12', 'Bx15', 'Bx17', 'Bx19', 'Bx21', 'Bx22',
    'Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q10', 'Q11',
    'Q12', 'Q13', 'Q15', 'Q16', 'Q17', 'Q20', 'Q25', 'Q27', 'Q30',
    'S40', 'S42', 'S44', 'S46', 'S48', 'S51', 'S52', 'S53', 'S54',
  ];
  const occupancies = ['seatsAvailable', 'standingAvailable', 'full', null];
  const progressRates = ['normalProgress', 'normalProgress', 'normalProgress', 'noProgress'];

  // NYC bounding box regions for realistic distribution
  const regions = [
    // Manhattan (dense)
    { lat: [40.71, 40.80], lng: [-74.01, -73.94], weight: 35 },
    // Brooklyn
    { lat: [40.57, 40.70], lng: [-74.04, -73.86], weight: 20 },
    // Queens
    { lat: [40.65, 40.78], lng: [-73.88, -73.72], weight: 15 },
    // Bronx
    { lat: [40.80, 40.90], lng: [-73.93, -73.79], weight: 15 },
    // Staten Island
    { lat: [40.50, 40.58], lng: [-74.25, -74.07], weight: 5 },
    // Midtown (extra dense)
    { lat: [40.748, 40.762], lng: [-73.995, -73.968], weight: 10 },
  ];

  const totalWeight = regions.reduce((s, r) => s + r.weight, 0);
  const hour = new Date().getHours();
  // Simulate time-of-day variation
  let busCount;
  if (hour >= 7 && hour <= 9) busCount = 3800;       // morning rush
  else if (hour >= 16 && hour <= 19) busCount = 4000; // evening rush
  else if (hour >= 10 && hour <= 15) busCount = 3200; // midday
  else if (hour >= 5 && hour <= 6) busCount = 1500;   // early morning
  else if (hour >= 20 && hour <= 23) busCount = 2000;  // evening
  else busCount = 800;                                  // late night

  // Add some randomness
  busCount += Math.floor((Math.random() - 0.5) * 200);

  const vehicles = [];
  for (let i = 0; i < busCount; i++) {
    // Pick region weighted
    let r = Math.random() * totalWeight;
    let region;
    for (const reg of regions) {
      r -= reg.weight;
      if (r <= 0) { region = reg; break; }
    }
    if (!region) region = regions[0];

    const lat = region.lat[0] + Math.random() * (region.lat[1] - region.lat[0]);
    const lng = region.lng[0] + Math.random() * (region.lng[1] - region.lng[0]);
    const route = routes[Math.floor(Math.random() * routes.length)];
    const borough = route[0] === 'M' ? 'Manhattan' :
                    route[0] === 'B' && route[1] === 'x' ? 'Bronx' :
                    route[0] === 'B' ? 'Brooklyn' :
                    route[0] === 'Q' ? 'Queens' : 'Staten Island';

    vehicles.push({
      vehicleRef: `MTA_DEMO_${i}`,
      lineRef: `MTA NYCT_${route}`,
      publishedLineName: route,
      directionRef: Math.random() > 0.5 ? '0' : '1',
      destination: `${borough} Terminal`,
      latitude: lat + (Math.random() - 0.5) * 0.001, // small jitter each poll
      longitude: lng + (Math.random() - 0.5) * 0.001,
      bearing: Math.random() * 360,
      progressRate: progressRates[Math.floor(Math.random() * progressRates.length)],
      progressStatus: null,
      occupancy: occupancies[Math.floor(Math.random() * occupancies.length)],
      recordedAt: new Date().toISOString(),
    });
  }
  return vehicles;
}

async function poll() {
  const vehicles = await fetchAllVehicles();
  if (vehicles) {
    previousVehicles = latestVehicles;
    latestVehicles = vehicles;
    lastPollTime = new Date().toISOString();

    // Save to database
    try {
      saveSnapshot(lastPollTime, vehicles);
    } catch (err) {
      console.error('Error saving snapshot:', err.message);
    }

    // Broadcast to WebSocket clients
    broadcast({
      type: 'update',
      timestamp: lastPollTime,
      vehicles,
      previousVehicles: previousVehicles.length > 0 ? previousVehicles : undefined,
    });
  }
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('Client connected');
  // Send current state immediately
  if (latestVehicles.length > 0) {
    ws.send(JSON.stringify({
      type: 'update',
      timestamp: lastPollTime,
      vehicles: latestVehicles,
    }));
  }
  ws.on('close', () => console.log('Client disconnected'));
});

// Start server
server.listen(PORT, () => {
  console.log(`MTA Bus Heatmap server running on http://localhost:${PORT}`);
  console.log(`Polling MTA API every ${POLL_INTERVAL / 1000}s`);

  // Initial poll
  poll();
  // Continue polling
  setInterval(poll, POLL_INTERVAL);

  // Clean old data daily
  setInterval(() => cleanOldData(7), 86400000);
});
