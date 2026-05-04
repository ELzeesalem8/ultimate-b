const { Pool } = require('pg');

// Use the connection string from your .env file
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Required for Neon/Serverless connections
  }
});

// Simple test to ensure the connection is alive
pool.connect((err, client, release) => {
  if (err) {
    return console.error('❌ Error acquiring client', err.stack);
  }
  console.log('✅ Connected to Neon PostgreSQL');
  release();
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};