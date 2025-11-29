// src/models/bots.js
const db = require('../lib/pgClient');
const { v4: uuidv4 } = require('uuid');

/**
 * createBot(botObj) - botObj should contain userId, pair, config, status (optional)
 */
async function createBot(botObj) {
  const id = botObj.id || uuidv4();
  const q = `INSERT INTO bots (id, user_id, pair, config, status, created_at, updated_at, entries)
             VALUES ($1,$2,$3,$4,$5,now(),now(), $6) RETURNING *`;
  const params = [id, botObj.userId, botObj.pair, JSON.stringify(botObj.config || {}), botObj.status || 'created', JSON.stringify(botObj.entries || [])];
  const { rows } = await db.query(q, params);
  return rows[0];
}

async function findById(id) {
  const q = `SELECT * FROM bots WHERE id = $1 LIMIT 1`;
  const { rows } = await db.query(q, [id]);
  return rows[0] || null;
}

async function findAll() {
  const q = `SELECT * FROM bots ORDER BY created_at DESC`;
  const { rows } = await db.query(q);
  return rows;
}

/**
 * updatePartial - only sets provided fields (config, status, closed_at, etc).
 * fields param: object of column -> value
 */
async function updatePartial(id, fields = {}) {
  const sets = [];
  const vals = [];
  let idx = 1;
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = $${idx++}`);
    vals.push(k === 'config' || k === 'entries' ? JSON.stringify(v) : v);
  }
  if (sets.length === 0) return findById(id);
  // always update updated_at
  vals.push(id);
  const q = `UPDATE bots SET ${sets.join(', ')}, updated_at = now() WHERE id = $${idx} RETURNING *`;
  const { rows } = await db.query(q, vals);
  return rows[0] || null;
}

/**
 * pushEntry - append an entry object to bots.entries (JSONB array) atomically
 */
async function pushEntry(id, entry) {
  const q = `UPDATE bots
             SET entries = COALESCE(entries, '[]'::jsonb) || $1::jsonb,
                 updated_at = now()
             WHERE id = $2
             RETURNING *`;
  const entryJson = JSON.stringify(entry);
  const { rows } = await db.query(q, [entryJson, id]);
  return rows[0] || null;
}

async function setStatus(id, status) {
  return updatePartial(id, { status });
}

async function setClosed(id) {
  return updatePartial(id, { status: 'closed', closed_at: new Date() });
}

module.exports = { createBot, findById, findAll, updatePartial, pushEntry, setStatus, setClosed };
