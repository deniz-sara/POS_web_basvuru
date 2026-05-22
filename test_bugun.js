require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function run() {
  const result1 = await pool.query("SELECT basvuru_tarihi FROM applications ORDER BY basvuru_tarihi DESC LIMIT 5");
  console.log("Recent dates:", result1.rows);

  const result2 = await pool.query("SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Istanbul')::date as today, CURRENT_TIMESTAMP as raw_ts, CURRENT_DATE as raw_date");
  console.log("Today evaluated as:", result2.rows[0]);

  const result3 = await pool.query("SELECT COUNT(*) as c1 FROM applications WHERE basvuru_tarihi >= CURRENT_DATE");
  console.log("Count with >= CURRENT_DATE:", result3.rows[0].c1);

  const result4 = await pool.query("SELECT COUNT(*) as c2 FROM applications WHERE (basvuru_tarihi AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Istanbul')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Istanbul')::date");
  console.log("Count with AT TIME ZONE logic:", result4.rows[0].c2);

  const result5 = await pool.query("SELECT COUNT(*) as c3 FROM applications WHERE basvuru_tarihi::date = CURRENT_DATE");
  console.log("Count with just ::date = CURRENT_DATE:", result5.rows[0].c3);

  const result6 = await pool.query("SELECT COUNT(*) as c4 FROM applications WHERE (basvuru_tarihi AT TIME ZONE 'Europe/Istanbul')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Istanbul')::date");
  console.log("Count with basvuru_tarihi AT TIME ZONE 'Europe/Istanbul':", result6.rows[0].c4);

  const result7 = await pool.query("SELECT COUNT(*) as c5 FROM applications WHERE (basvuru_tarihi AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Istanbul')::date = CURRENT_DATE");
  console.log("Count with basvuru_tarihi AT TIME ZONE ...Istanbul::date = CURRENT_DATE:", result7.rows[0].c5);

  process.exit(0);
}
run().catch(console.error);
