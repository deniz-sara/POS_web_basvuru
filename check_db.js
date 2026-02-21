require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        const res = await pool.query("SELECT id, belge_tipi, orijinal_ad, dosya_yolu, durum FROM documents WHERE orijinal_ad LIKE '%.pdf' ORDER BY id DESC LIMIT 5");
        console.log("Latest PDF uploads:");
        res.rows.forEach(r => console.log(r));
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}
run();
