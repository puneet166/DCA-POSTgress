// src/models/users.js
const db = require('../lib/pgClient');
const { v4: uuidv4 } = require('uuid');

async function createOrUpdateUser({ id, apiKey, apiSecret, exchange }) {
  const uid = id || uuidv4();
  const q = `
    INSERT INTO users (id, api_key, api_secret, exchange, created_at, updated_at)
    VALUES ($1,$2,$3,$4, now(), now())
    ON CONFLICT (id) DO UPDATE
      SET api_key = EXCLUDED.api_key,
          api_secret = EXCLUDED.api_secret,
          exchange = EXCLUDED.exchange,
          updated_at = now()
    RETURNING *;
  `;
  const { rows } = await db.query(q, [uid, apiKey, apiSecret, exchange || 'bybit']);
  return rows[0];
}

async function findById(id) {
  const q = `SELECT * FROM users WHERE id = $1 LIMIT 1`;
  const { rows } = await db.query(q, [id]);
  return rows[0] || null;
}

async function listAll() {
  const q = `SELECT id, exchange, created_at, updated_at, api_key FROM users`;
  const { rows } = await db.query(q);
  return rows;
}

module.exports = { createOrUpdateUser, findById, listAll };
