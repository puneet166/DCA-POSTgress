// src/models/botLogs.js
const db = require('../lib/pgClient');
const { v4: uuidv4 } = require('uuid');

async function insertLog({ botId, event, level = 'info', meta = {}, ts = new Date() }) {
  const id = uuidv4();
  const q = `INSERT INTO bot_logs (id, bot_id, event, level, meta, ts) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`;
  const params = [id, botId, event, level, JSON.stringify(meta || {}), ts];
  const { rows } = await db.query(q, params);
  return rows[0];
}

async function listByBot(botId, limit = 200) {
  const q = `SELECT * FROM bot_logs WHERE bot_id = $1 ORDER BY ts DESC LIMIT $2`;
  const { rows } = await db.query(q, [botId, limit]);
  return rows;
}

module.exports = { insertLog, listByBot };
