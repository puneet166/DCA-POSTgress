// src/models/botOrders.js
const db = require('../lib/pgClient');
const { v4: uuidv4 } = require('uuid');

async function insertOrder({ botId, orderId, side, amount, price, raw, exitType = null, reason = null }) {
  const id = uuidv4();
  const q = `INSERT INTO bot_orders (id, bot_id, order_id, side, amount, price, raw, exit_type, reason, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now()) RETURNING *`;
  const params = [id, botId, orderId, side, amount, price, JSON.stringify(raw || {}), exitType, reason];
  const { rows } = await db.query(q, params);
  return rows[0];
}
async function findByOrderId(orderId) {
  const q = `SELECT * FROM bot_orders WHERE order_id = $1 LIMIT 1`;
  const { rows } = await db.query(q, [orderId]);
  return rows[0] || null;
}
/**
 * List orders for a bot (newest first)
 * @param {string} botId
 * @param {object} opts
 * @param {number} opts.limit - max number of orders
 * @param {string} [opts.side] - optional filter: 'buy' or 'sell'
 */
async function listByBot(botId, { limit = 100, side } = {}) {
  const params = [botId];
  let idx = 2;

  let q = `SELECT * FROM bot_orders WHERE bot_id = $1`;

  if (side) {
    q += ` AND side = $${idx++}`;
    params.push(side);
  }

  q += ` ORDER BY created_at DESC LIMIT $${idx}`;
  params.push(limit);

  const { rows } = await db.query(q, params);
  return rows;
}
// ✅ Proper Postgres helper: get latest order for this bot
async function getLastOrderByBotId(botId) {
  const q = `
    SELECT *
    FROM bot_orders
    WHERE bot_id = $1
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const { rows } = await db.query(q, [botId]);
  return rows[0] || null;
}

module.exports = { insertOrder, findByOrderId,listByBot,getLastOrderByBotId };
