const pool = require('./database/db');
async function run() {
  const res = await pool.query("SELECT id, application_id, belge_tipi, dosya_yolu, orijinal_ad FROM documents ORDER BY id DESC LIMIT 5");
  console.log(JSON.stringify(res.rows, null, 2));
  process.exit(0);
}
run();
