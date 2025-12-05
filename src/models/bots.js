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

async function findAll(userId) {
  const q = `
    SELECT *
    FROM bots
    WHERE user_id = $1
    ORDER BY created_at DESC
  `;
  
  const { rows } = await db.query(q, [userId]);
  return rows;
}


/**
 * updatePartial - only sets provided fields (config, status, closed_at, etc).
 * fields param: object of column -> value
 */
// async function updatePartial(id, fields = {}) {
//   const sets = [];
//   const vals = [];
//   let idx = 1;
//   for (const [k, v] of Object.entries(fields)) {
//     sets.push(`${k} = $${idx++}`);
//     vals.push(k === 'config' || k === 'entries' ? JSON.stringify(v) : v);
//   }
//   if (sets.length === 0) return findById(id);
//   // always update updated_at
//   vals.push(id);
//   const q = `UPDATE bots SET ${sets.join(', ')}, updated_at = now() WHERE id = $${idx} RETURNING *`;
//   const { rows } = await db.query(q, vals);
//   return rows[0] || null;
// }
async function updatePartial(id, patch = {}) {
  // allowed columns you support updating
  const allowed = ['status','config','entries','updated_at','closed_at','deleted_at'];
  const keys = Object.keys(patch).filter(k => allowed.includes(k));
  if (keys.length === 0) return null;

  const sets = [];
  const values = [];

  // parameters start at $2 because $1 is id
  keys.forEach((k, idx) => {
    sets.push(`${k} = $${idx + 2}`);
    values.push(patch[k]);
  });

  // Add updated_at = NOW() only if caller didn't include `updated_at`
  if (!keys.includes('updated_at')) {
    sets.push(`updated_at = NOW()`);
  }

  const q = `UPDATE bots SET ${sets.join(', ')} WHERE id = $1 RETURNING *;`;
  const params = [id, ...values];
  const { rows } = await db.query(q, params);
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
async function deleteById(id) {
  // Return the deleted row (useful for logging), we perform a DELETE ... RETURNING *
  const q = `DELETE FROM bots WHERE id = $1 RETURNING *`;
  const { rows } = await db.query(q, [id]);
  return rows[0] || null;
}
async function findByStatus(status) {
  const q = `SELECT * FROM bots WHERE status = $1`;
  const { rows } = await db.query(q, [status]);
  return rows;
}
async function markDeleted(id) {
  const q = `
    UPDATE bots
    SET status = 'deleted',
        deleted_at = NOW(),
        updated_at = NOW()
    WHERE id = $1
    RETURNING *;
  `;
  const { rows } = await db.query(q, [id]);
  return rows[0] || null;
}

async function countBots(userId) {
  const result = await db.query(
    `SELECT COUNT(*) FROM bots WHERE "user_id" = $1 AND status != 'deleted'`,
    [userId]
  );
  return Number(result.rows[0].count);
}

// Find bot for same pair
async function findBotByPair({ userId, pair }) {
  const result = await db.query(
    `SELECT * FROM bots 
     WHERE "user_id" = $1 AND pair = $2 AND status != 'deleted'
     LIMIT 1`,
    [userId, pair]
  );
  return result.rows[0] || null;
}

// async function findActiveBots() {
//   const q = `SELECT * FROM bots WHERE status NOT IN ('deleting', 'deleted') ORDER BY created_at DESC`;
//   const { rows } = await db.query(q);
//   return rows;
// }

async function findActiveBots(userId) {
  const q = `
    SELECT *
    FROM bots
    WHERE user_id = $1
      AND status NOT IN ('deleting', 'deleted')
    ORDER BY created_at DESC
  `;
  
  const { rows } = await db.query(q, [userId]);
  return rows;
}


module.exports = { createBot, findById, findAll, updatePartial, pushEntry, setStatus, setClosed,deleteById,markDeleted ,findByStatus,countBots,findBotByPair,findActiveBots };
