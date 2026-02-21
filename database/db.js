const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const initializeDatabase = async () => {
  try {
    // Veritabanı tablolarını oluştur (PostgreSQL uyumlu)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS applications (
        id SERIAL PRIMARY KEY,
        basvuru_no TEXT UNIQUE NOT NULL,
        token TEXT UNIQUE NOT NULL,
        
        firma_unvani TEXT NOT NULL,
        tabela_adi TEXT DEFAULT '',
        sirket_tipi TEXT DEFAULT 'Sahis',
        tc_no TEXT,
        vergi_no TEXT,
        vergi_dairesi TEXT NOT NULL,
        ticaret_sicil_no TEXT NOT NULL,
        faaliyet_alani TEXT NOT NULL,
        adres TEXT NOT NULL,
        il TEXT NOT NULL,
        ilce TEXT NOT NULL,
        
        yetkili_ad_soyad TEXT NOT NULL,
        telefon TEXT NOT NULL,
        email TEXT NOT NULL,
        alt_telefon TEXT,
        
        pos_adedi INTEGER NOT NULL,
        pos_tipi TEXT NOT NULL,
        aylik_ciro REAL NOT NULL,
        
        durum TEXT NOT NULL DEFAULT 'alindi',
        durum_aciklama TEXT,
        
        basvuru_tarihi TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        guncelleme_tarihi TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS documents (
        id SERIAL PRIMARY KEY,
        application_id INTEGER NOT NULL,
        belge_tipi TEXT NOT NULL,
        belge_adi TEXT NOT NULL,
        dosya_yolu TEXT NOT NULL,
        orijinal_ad TEXT,
        boyut INTEGER,
        zorunlu INTEGER DEFAULT 1,
        durum TEXT DEFAULT 'yuklendi',
        yukleme_tarihi TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (application_id) REFERENCES applications(id)
      );

      CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        ad_soyad TEXT NOT NULL,
        aktif INTEGER DEFAULT 1,
        olusturma_tarihi TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        application_id INTEGER,
        tip TEXT NOT NULL,
        alici TEXT NOT NULL,
        konu TEXT,
        icerik TEXT,
        durum TEXT DEFAULT 'gonderildi',
        hata TEXT,
        gonderim_tarihi TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (application_id) REFERENCES applications(id)
      );

      CREATE TABLE IF NOT EXISTS application_notes (
        id SERIAL PRIMARY KEY,
        application_id INTEGER NOT NULL,
        admin_id INTEGER,
        not_metni TEXT NOT NULL,
        olusturma_tarihi TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (application_id) REFERENCES applications(id)
      );
    `);

    // Auto-migration for existing databases
    try {
      await pool.query('ALTER TABLE applications ADD COLUMN tc_no TEXT');
      console.log("Migration: tc_no kotonu eklendi.");
    } catch (e) { } // Ignores error if column already exists

    // Auto-migration for existing databases
    try {
      await pool.query('ALTER TABLE applications ADD COLUMN vergi_no TEXT');
      console.log("Migration: vergi_no kolonu eklendi.");
    } catch (e) { } // Ignores error if column already exists

    // Default admin eklentisi
    const bcrypt = require('bcryptjs');
    const adminExists = await pool.query('SELECT id FROM admin_users WHERE email = $1', ['admin@pos.com']);
    if (adminExists.rows.length === 0) {
      const hash = bcrypt.hashSync('Admin123!', 10);
      await pool.query('INSERT INTO admin_users (email, password_hash, ad_soyad) VALUES ($1, $2, $3)', ['admin@pos.com', hash, 'Sistem Admin']);
      console.log('✅ Default admin created: admin@pos.com / Admin123!');
    }
    console.log('✅ Database synchronized with PostgreSQL');
  } catch (err) {
    if (!process.env.DATABASE_URL) {
      console.log('⚠️ PostgreSQL veritabanı url (DATABASE_URL) bulunamadı. Lütfen .env dosyasına ekleyin.');
    } else {
      console.error('Database initialization error:', err);
    }
  }
};

initializeDatabase();

module.exports = pool;
