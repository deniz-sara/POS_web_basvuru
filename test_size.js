require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function check() {
  const dbRes = await pool.query('SELECT pg_size_pretty(pg_database_size(current_database())) as db_size, pg_database_size(current_database()) as db_bytes');
  console.log("DB Size:", dbRes.rows[0]);

  const tblRes = await pool.query(`
    SELECT sum(pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(tablename)))::bigint as tbl_bytes
    FROM pg_tables 
    WHERE schemaname = 'public'
  `);
  console.log("Public Tables Size (Bytes):", tblRes.rows[0]);

  process.exit();
}
check();
