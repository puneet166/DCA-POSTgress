// scripts/runMigrations.js
const fs = require('fs');
const path = require('path');
const pg = require('../lib/pgClient');

async function run() {
  try {
    const sql = fs.readFileSync(path.join(__dirname, '../../migrations/002_init_schema.sql'), 'utf8');
    await pg.query(sql);
    console.log('Migration applied');
    process.exit(0);
  } catch (err) {
    console.error('Migration error', err);
    process.exit(1);
  }
}

run();
