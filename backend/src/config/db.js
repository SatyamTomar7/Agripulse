require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    console.error('Database query failed:', err.message);
    throw Object.assign(new Error('Database unavailable. Check DATABASE_URL and PostgreSQL.'), {
      status: 503,
      code: 'DATABASE_UNAVAILABLE',
      cause: err
    });
  }
}

module.exports = { pool, query };
