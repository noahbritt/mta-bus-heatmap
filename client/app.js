(async function () {
  'use strict';

  // ---- Config ----
  const config = await fetch('/api/config').then(r => r.json());
  if (config.demoMode) {
    document.getElementById('demo-badge').style.display = 'block';
  }

  // ---- State ----
  let vehicles = [];
  let previousVehicles = [];
  let filteredVehicles = [];
  let viewMode = 'dots';
  let colorBy = 'route';
  let boroughFilter = 'all';
  let routeFilter = 'all';
  let routeSearch = '';
  let isLive = true;
  let pulseMode = false;
  let pulsePhase = 0;
  let allRoutes = new Set();

  // Interpolation
  let interpStart = 0;
  let interpDuration = 30000;
  let interpVehicles = [];
  let interpAnimId = null;

  // Timelapse
  let timelapseSnapshots = [];
  let timelapseIndex = 0;
  let timelapseSpeed = 60;
  let timelapsePlaying = false;
  let timelapseTimer = null;

  // ---- Borough Bounding Boxes ----
  const boroughs = {
    manhattan:    { lat: [40.700, 40.882], lng: [-74.020, -73.907] },
    brooklyn:     { lat: [40.570, 40.739], lng: [-74.042, -73.855] },
    queens:       { lat: [40.541, 40.812], lng: [-73.962, -73.700] },
    bronx:        { lat: [40.785, 40.917], lng: [-73.933, -73.748] },
    statenisland: { lat: [40.496, 40.651], lng: [-74.255, -74.052] },
  };

  function inBorough(lat, lng, borough) {
    const b = boroughs[borough];
    return lat >= b.lat[0] && lat <= b.lat[1] && lng >= b.lng[0] && lng <= b.lng[1];
  }

  // ---- Route Color Hashing ----
  const routeColorCache = {};
  function routeColor(name) {
    if (routeColorCache[name]) return routeColorCache[name];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    const h = ((hash % 360) + 360) % 360;
    const r = Math.round(Math.cos(h * Math.PI / 180) * 80 + 175);
    const g = Math.round(Math.cos((h - 120) * Math.PI / 180) * 80 + 175);
    const b = Math.round(Math.cos((h - 240) * Math.PI / 180) * 80 + 175);
    routeColorCache[name] = `rgb(${r},${g},${b})`;
    return routeColorCache[name];
  }

  // ---- Map Setup (Leaflet + CartoDB dark tiles, locked to NYC) ----
  // Tight bounding box around the 5 boroughs — excludes NJ
  const NYC_BOUNDS = L.latLngBounds(
    [40.49, -74.26],  // SW corner (south Staten Island)
    [40.92, -73.68]   // NE corner (north Bronx / east Queens)
  );

  const map = L.map('map', {
    center: [40.735, -73.90],
    zoom: 11.5,
    zoomControl: false,
    maxBounds: NYC_BOUNDS.pad(0.05),  // tiny padding so it doesn't feel claustrophobic
    maxBoundsViscosity: 1.0,          // hard wall — can't pan outside NYC
    minZoom: 10,
    maxZoom: 18,
  });

  // Fit the map to show all 5 boroughs
  map.fitBounds(NYC_BOUNDS);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  // Dark map tiles (CartoDB dark matter — free, no key)
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);

  // Add labels as a separate layer on top (so they render above bus dots)
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd',
    maxZoom: 19,
    pane: 'overlayPane',
  }).addTo(map);

  // ---- Layers ----
  let heatLayer = null;
  let dotLayerGroup = L.layerGroup().addTo(map);

  // ---- Filtering ----
  function applyFilters() {
    const src = interpVehicles.length > 0 ? interpVehicles : vehicles;
    filteredVehicles = src.filter(v => {
      if (boroughFilter !== 'all' && !inBorough(v.latitude, v.longitude, boroughFilter)) return false;
      if (routeFilter !== 'all' && v.publishedLineName !== routeFilter) return false;
      if (routeSearch && !v.publishedLineName?.toLowerCase().startsWith(routeSearch.toLowerCase())) return false;
      return true;
    });
    render();
    updateStats();
  }

  // ---- Rendering ----
  function render() {
    if (viewMode === 'heatmap') {
      renderHeatmap();
    } else {
      renderDots();
    }
  }

  function renderHeatmap() {
    // Remove dots
    dotLayerGroup.clearLayers();

    // Build heatmap data: [lat, lng, intensity]
    const points = filteredVehicles.map(v => [v.latitude, v.longitude, 0.6]);

    if (heatLayer) {
      heatLayer.setLatLngs(points);
    } else {
      heatLayer = L.heatLayer(points, {
        radius: 20,
        blur: 15,
        maxZoom: 17,
        max: 1.0,
        gradient: {
          0.0: 'rgba(0,0,0,0)',
          0.2: '#ff6b35',
          0.5: '#ff3366',
          0.8: '#ff3366',
          1.0: '#ffdc64',
        },
      }).addTo(map);
    }
  }

  function renderDots() {
    // Remove heatmap
    if (heatLayer) {
      map.removeLayer(heatLayer);
      heatLayer = null;
    }

    dotLayerGroup.clearLayers();

    for (const v of filteredVehicles) {
      const color = getBusColorCSS(v);
      const marker = L.circleMarker([v.latitude, v.longitude], {
        radius: 4,
        fillColor: color,
        fillOpacity: 0.85,
        color: 'rgba(0,0,0,0.3)',
        weight: 1,
      });

      marker.bindPopup(
        `<b>${v.publishedLineName || 'Unknown'}</b><br>` +
        `${v.destination || ''}<br>` +
        `${v.occupancy || 'Unknown occupancy'}<br>` +
        `${v.progressRate === 'noProgress' ? 'Stationary' : 'Moving'}`,
        { className: 'dark-popup' }
      );

      dotLayerGroup.addLayer(marker);
    }
  }

  function getBusColorCSS(bus) {
    if (colorBy === 'occupancy') {
      switch (bus.occupancy) {
        case 'seatsAvailable': return '#4ade80';
        case 'standingAvailable': return '#fbbf24';
        case 'full': return '#f87171';
        default: return '#969696';
      }
    }
    if (colorBy === 'speed') {
      return bus.progressRate === 'noProgress' ? '#f87171' : '#4ade80';
    }
    return routeColor(bus.publishedLineName || 'unknown');
  }

  // ---- Stats ----
  function updateStats() {
    const data = filteredVehicles;
    document.getElementById('stat-total').textContent = data.length.toLocaleString();

    const routeCounts = {};
    let maxRoute = '—', maxCount = 0;
    for (const v of data) {
      const name = v.publishedLineName || 'unknown';
      routeCounts[name] = (routeCounts[name] || 0) + 1;
      if (routeCounts[name] > maxCount) {
        maxCount = routeCounts[name];
        maxRoute = name;
      }
    }
    document.getElementById('stat-busiest').textContent = maxCount > 0 ? `${maxRoute} (${maxCount})` : '—';

    const moving = data.filter(v => v.progressRate !== 'noProgress').length;
    document.getElementById('stat-moving').textContent = moving.toLocaleString();
    document.getElementById('stat-stationary').textContent = (data.length - moving).toLocaleString();

    const seats = data.filter(v => v.occupancy === 'seatsAvailable').length;
    const standing = data.filter(v => v.occupancy === 'standingAvailable').length;
    const full = data.filter(v => v.occupancy === 'full').length;
    const total = Math.max(seats + standing + full, 1);
    document.getElementById('bar-seats').style.width = (seats / total * 100) + '%';
    document.getElementById('bar-standing').style.width = (standing / total * 100) + '%';
    document.getElementById('bar-full').style.width = (full / total * 100) + '%';
    document.getElementById('cnt-seats').textContent = seats;
    document.getElementById('cnt-standing').textContent = standing;
    document.getElementById('cnt-full').textContent = full;

    updateRouteList(routeCounts);
    updateColorLegend();
  }

  function updateRouteList(routeCounts) {
    const entries = Object.entries(routeCounts || {}).sort((a, b) => a[0].localeCompare(b[0]));
    const newRoutes = entries.map(([name]) => name);
    if (JSON.stringify([...allRoutes].sort()) !== JSON.stringify(newRoutes.sort())) {
      allRoutes = new Set(newRoutes);
      const sel = document.getElementById('route-select');
      const currentVal = sel.value;
      sel.innerHTML = '<option value="all">All Routes</option>';
      for (const [name, count] of entries) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = `${name} (${count})`;
        sel.appendChild(opt);
      }
      sel.value = currentVal;
    }
  }

  function updateColorLegend() {
    const legend = document.getElementById('color-legend');
    if (viewMode !== 'dots') { legend.innerHTML = ''; return; }
    let html = '<div class="legend-title">Legend</div>';
    if (colorBy === 'occupancy') {
      html += li('#4ade80', 'Seats Available');
      html += li('#fbbf24', 'Standing');
      html += li('#f87171', 'Full');
      html += li('#969696', 'Unknown');
    } else if (colorBy === 'speed') {
      html += li('#4ade80', 'Moving');
      html += li('#f87171', 'Stationary');
    } else {
      html += '<div style="font-size:11px;color:#888">Colors auto-assigned by route</div>';
    }
    legend.innerHTML = html;
  }

  function li(color, label) {
    return `<div class="legend-item"><div class="legend-dot" style="background:${color}"></div>${label}</div>`;
  }

  // ---- Hot Zone Tooltip (click on heatmap) ----
  map.on('click', (e) => {
    if (viewMode !== 'heatmap') return;
    const radius = 0.003;
    const nearby = filteredVehicles.filter(v =>
      Math.abs(v.latitude - e.latlng.lat) < radius &&
      Math.abs(v.longitude - e.latlng.lng) < radius
    );
    if (nearby.length === 0) return;
    const routeCounts = {};
    for (const v of nearby) {
      const name = v.publishedLineName || 'unknown';
      routeCounts[name] = (routeCounts[name] || 0) + 1;
    }
    const sorted = Object.entries(routeCounts).sort((a, b) => b[1] - a[1]);
    const content = `<b>${nearby.length} buses in this area</b><br>` +
      sorted.map(([r, c]) => `${r}: ${c}`).join('<br>');
    L.popup()
      .setLatLng(e.latlng)
      .setContent(content)
      .openOn(map);
  });

  // ---- Position Interpolation ----
  function startInterpolation(newVehicles, prevVehicles) {
    if (interpAnimId) cancelAnimationFrame(interpAnimId);

    if (!prevVehicles || prevVehicles.length === 0) {
      interpVehicles = newVehicles;
      applyFilters();
      return;
    }

    const prevMap = {};
    for (const v of prevVehicles) {
      if (v.vehicleRef) prevMap[v.vehicleRef] = v;
    }

    interpStart = performance.now();
    interpDuration = config.pollInterval || 30000;

    function step() {
      const elapsed = performance.now() - interpStart;
      const frac = Math.min(elapsed / interpDuration, 1);
      const eased = frac * frac * (3 - 2 * frac);

      interpVehicles = newVehicles.map(v => {
        const prev = prevMap[v.vehicleRef];
        if (!prev) return v;
        return {
          ...v,
          latitude: prev.latitude + (v.latitude - prev.latitude) * eased,
          longitude: prev.longitude + (v.longitude - prev.longitude) * eased,
        };
      });

      applyFilters();

      if (frac < 1) {
        interpAnimId = requestAnimationFrame(step);
      }
    }

    step();
  }

  // ---- Pulse Animation ----
  (function animatePulse() {
    if (pulseMode && viewMode === 'heatmap' && heatLayer) {
      pulsePhase += 0.05;
      const r = 20 + 8 * Math.sin(pulsePhase);
      heatLayer.setOptions({ radius: r });
    }
    requestAnimationFrame(animatePulse);
  })();

  // ---- WebSocket ----
  function connectWS() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}`);

    ws.onmessage = (event) => {
      if (!isLive) return;
      const msg = JSON.parse(event.data);
      if (msg.type === 'update') {
        previousVehicles = msg.previousVehicles || vehicles;
        vehicles = msg.vehicles;
        document.getElementById('stat-time').textContent = new Date(msg.timestamp).toLocaleTimeString();
        startInterpolation(vehicles, previousVehicles);
      }
    };

    ws.onclose = () => setTimeout(connectWS, 3000);
    ws.onerror = () => ws.close();
  }
  connectWS();

  // ---- Controls ----
  document.querySelectorAll('[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-mode]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      viewMode = btn.dataset.mode;
      document.getElementById('color-by-group').style.display = viewMode === 'dots' ? '' : 'none';
      applyFilters();
    });
  });

  document.querySelectorAll('[data-color]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-color]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      colorBy = btn.dataset.color;
      applyFilters();
    });
  });

  document.getElementById('borough-filter').addEventListener('change', (e) => {
    boroughFilter = e.target.value;
    applyFilters();
  });

  document.getElementById('route-select').addEventListener('change', (e) => {
    routeFilter = e.target.value;
    routeSearch = '';
    document.getElementById('route-filter').value = '';
    applyFilters();
  });

  document.getElementById('route-filter').addEventListener('input', (e) => {
    routeSearch = e.target.value;
    routeFilter = 'all';
    document.getElementById('route-select').value = 'all';
    applyFilters();
  });

  document.querySelectorAll('[data-live]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-live]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      isLive = btn.dataset.live === 'live';
      document.getElementById('timelapse-panel').classList.toggle('visible', !isLive);
      if (!isLive) loadRecordedDays();
    });
  });

  document.getElementById('pulse-toggle').addEventListener('change', (e) => {
    pulseMode = e.target.checked;
  });

  // ---- Timelapse ----
  async function loadRecordedDays() {
    const days = await fetch('/api/recorded-days').then(r => r.json());
    const sel = document.getElementById('tl-day');
    sel.innerHTML = '<option value="">Select day...</option>';
    for (const day of days) {
      const opt = document.createElement('option');
      opt.value = day.day;
      opt.textContent = `${day.day} (${day.snapshots} snapshots)`;
      sel.appendChild(opt);
    }
  }

  document.getElementById('tl-day').addEventListener('change', async (e) => {
    const day = e.target.value;
    if (!day) return;
    stopTimelapse();
    const start = day + 'T00:00:00.000Z';
    const end = day + 'T23:59:59.999Z';
    timelapseSnapshots = await fetch(`/api/snapshots?start=${start}&end=${end}`).then(r => r.json());
    if (timelapseSnapshots.length > 0) {
      document.getElementById('timelapse-scrubber').max = timelapseSnapshots.length - 1;
      timelapseIndex = 0;
      loadTimelapseFrame(0);
    }
  });

  async function loadTimelapseFrame(index) {
    if (index < 0 || index >= timelapseSnapshots.length) return;
    timelapseIndex = index;
    const snapshot = timelapseSnapshots[index];
    const data = await fetch(`/api/snapshots/${snapshot.id}`).then(r => r.json());
    vehicles = data;
    interpVehicles = data;
    applyFilters();
    const time = new Date(snapshot.timestamp);
    document.getElementById('timelapse-clock').textContent = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    document.getElementById('timelapse-scrubber').value = index;
    document.getElementById('stat-time').textContent = time.toLocaleTimeString();
  }

  document.getElementById('tl-play').addEventListener('click', () => {
    timelapsePlaying ? stopTimelapse() : startTimelapse();
  });

  function startTimelapse() {
    if (timelapseSnapshots.length === 0) return;
    timelapsePlaying = true;
    document.getElementById('tl-play').textContent = 'Pause';
    document.getElementById('tl-play').classList.add('active');
    advanceTimelapse();
  }

  function advanceTimelapse() {
    if (!timelapsePlaying) return;
    timelapseSpeed = parseInt(document.getElementById('tl-speed').value);
    const frameInterval = Math.max(30000 / timelapseSpeed / 30, 50);
    loadTimelapseFrame(timelapseIndex);
    timelapseIndex = (timelapseIndex + 1) % timelapseSnapshots.length;
    timelapseTimer = setTimeout(advanceTimelapse, frameInterval);
  }

  function stopTimelapse() {
    timelapsePlaying = false;
    clearTimeout(timelapseTimer);
    document.getElementById('tl-play').textContent = 'Play';
    document.getElementById('tl-play').classList.remove('active');
  }

  document.getElementById('timelapse-scrubber').addEventListener('input', (e) => {
    stopTimelapse();
    loadTimelapseFrame(parseInt(e.target.value));
  });

})();
