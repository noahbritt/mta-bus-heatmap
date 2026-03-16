const express = require('express');
const { getRecordedDays, getSnapshotsInRange, getSnapshotData, getSnapshotAt } = require('./db');

const router = express.Router();

// Get list of recorded days
router.get('/api/recorded-days', (req, res) => {
  try {
    const days = getRecordedDays();
    res.json(days);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get snapshots for a time range (for timelapse)
router.get('/api/snapshots', (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ error: 'start and end query params required' });
    }
    const snapshots = getSnapshotsInRange(start, end);
    res.json(snapshots);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get vehicle data for a specific snapshot
router.get('/api/snapshots/:id', (req, res) => {
  try {
    const data = getSnapshotData(Number(req.params.id));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get the nearest snapshot to a given timestamp
router.get('/api/snapshot-at', (req, res) => {
  try {
    const { timestamp } = req.query;
    if (!timestamp) {
      return res.status(400).json({ error: 'timestamp query param required' });
    }
    const snapshot = getSnapshotAt(timestamp);
    res.json(snapshot || { vehicles: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
