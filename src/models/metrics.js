// src/models/metrics.js
const db = require('../lib/pgClient');

async function upsertMetrics(pair, lastBalanceSnapshot) {
  const q = `
    INSERT INTO metrics (pair, last_balance_snapshot, ts)
    VALUES ($1,$2, now())
    ON CONFLICT (pair) DO UPDATE SET
      last_balance_snapshot = EXCLUDED.last_balance_snapshot,
      ts = now()
    RETURNING *;`;
  const { rows } = await db.query(q, [pair, JSON.stringify(lastBalanceSnapshot || {})]);
  return rows[0];
}

async function findByPair(pair) {
  const q = `SELECT * FROM metrics WHERE pair = $1 LIMIT 1`;
  const { rows } = await db.query(q, [pair]);
  return rows[0] || null;
}

module.exports = { upsertMetrics, findByPair };
