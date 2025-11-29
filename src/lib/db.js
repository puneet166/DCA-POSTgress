// src/lib/db.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const pg = require('./pgClient');

let _connected = false;

/**
 * initDb - idempotent init for Postgres client pool.
 */
async function initDb() {
  if (_connected) return;
  // run a quick query to verify connection
  try {
    await pg.query('SELECT 1');
    _connected = true;
    console.log('[DB] Connected to Postgres');
  } catch (err) {
    console.error('[DB] Postgres init failed', err);
    throw err;
  }
}

/**
 * getDb - returns the pg helper (query/getClient)
 */
function getDb() {
  if (!_connected) throw new Error('DB not initialized. Call and await initDb() first.');
  return pg;
}

/**
 * closeDb - ends pool
 */
async function closeDb() {
  try {
    await pg.pool.end();
    _connected = false;
    console.log('[DB] Postgres pool closed');
  } catch (err) {
    console.error('[DB] error closing pool', err);
  }
}

module.exports = { initDb, getDb, closeDb };
