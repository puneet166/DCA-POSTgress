// src/lib/pgClient.js
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING || 'postgres://postgres:postgres@127.0.0.1:5432/dcabot'
  // tune pool options here
});

pool.on('error', (err) => {
  console.error('[pg] unexpected error on idle client', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  pool
};
