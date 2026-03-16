const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'bus_data.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_timestamp ON snapshots(timestamp);

    CREATE TABLE IF NOT EXISTS vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL,
      vehicle_ref TEXT,
      line_ref TEXT,
      published_line_name TEXT,
      direction_ref TEXT,
      destination TEXT,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      bearing REAL,
      progress_rate TEXT,
      progress_status TEXT,
      occupancy TEXT,
      recorded_at TEXT,
      FOREIGN KEY (snapshot_id) REFERENCES snapshots(id)
    );
    CREATE INDEX IF NOT EXISTS idx_vehicles_snapshot ON vehicles(snapshot_id);
    CREATE INDEX IF NOT EXISTS idx_vehicles_recorded ON vehicles(recorded_at);
  `);
}

function saveSnapshot(timestamp, vehicles) {
  const d = getDb();
  const insertSnapshot = d.prepare(
    'INSERT INTO snapshots (timestamp, data) VALUES (?, ?)'
  );
  const insertVehicle = d.prepare(`
    INSERT INTO vehicles (snapshot_id, vehicle_ref, line_ref, published_line_name,
      direction_ref, destination, latitude, longitude, bearing,
      progress_rate, progress_status, occupancy, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = d.transaction((ts, vehs) => {
    const result = insertSnapshot.run(ts, JSON.stringify(vehs));
    const snapshotId = result.lastInsertRowid;
    for (const v of vehs) {
      insertVehicle.run(
        snapshotId,
        v.vehicleRef,
        v.lineRef,
        v.publishedLineName,
        v.directionRef,
        v.destination,
        v.latitude,
        v.longitude,
        v.bearing,
        v.progressRate,
        v.progressStatus,
        v.occupancy,
        v.recordedAt
      );
    }
    return snapshotId;
  });

  return transaction(timestamp, vehicles);
}

function getSnapshotsInRange(startTime, endTime) {
  const d = getDb();
  return d.prepare(`
    SELECT id, timestamp FROM snapshots
    WHERE timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp ASC
  `).all(startTime, endTime);
}

function getSnapshotData(snapshotId) {
  const d = getDb();
  const row = d.prepare('SELECT data FROM snapshots WHERE id = ?').get(snapshotId);
  return row ? JSON.parse(row.data) : [];
}

function getRecordedDays() {
  const d = getDb();
  return d.prepare(`
    SELECT DISTINCT date(timestamp) as day, COUNT(*) as snapshots
    FROM snapshots
    GROUP BY date(timestamp)
    ORDER BY day DESC
  `).all();
}

function getSnapshotAt(timestamp) {
  const d = getDb();
  const row = d.prepare(`
    SELECT id, timestamp, data FROM snapshots
    WHERE timestamp <= ?
    ORDER BY timestamp DESC
    LIMIT 1
  `).get(timestamp);
  return row ? { id: row.id, timestamp: row.timestamp, vehicles: JSON.parse(row.data) } : null;
}

function cleanOldData(daysToKeep = 7) {
  const d = getDb();
  const cutoff = new Date(Date.now() - daysToKeep * 86400000).toISOString();
  d.prepare('DELETE FROM vehicles WHERE snapshot_id IN (SELECT id FROM snapshots WHERE timestamp < ?)').run(cutoff);
  d.prepare('DELETE FROM snapshots WHERE timestamp < ?').run(cutoff);
}

module.exports = {
  getDb,
  saveSnapshot,
  getSnapshotsInRange,
  getSnapshotData,
  getRecordedDays,
  getSnapshotAt,
  cleanOldData,
};
