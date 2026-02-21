const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

async function updateDb() {
    try {
        await pool.query(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS son_giris_tarihi TIMESTAMP;`);
        console.log('Added son_giris_tarihi to admin_users.');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_logs (
                id SERIAL PRIMARY KEY,
                admin_id INTEGER REFERENCES admin_users(id),
                islem_tipi VARCHAR(100),
                basvuru_id INTEGER,
                detay TEXT,
                tarih TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Created admin_logs table.');
    } catch (err) {
        console.error('Migration error:', err);
    } finally {
        await pool.end();
    }
}

updateDb();
