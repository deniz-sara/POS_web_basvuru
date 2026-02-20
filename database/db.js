const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'pos.db');
const db = new Database(dbPath);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    basvuru_no TEXT UNIQUE NOT NULL,
    token TEXT UNIQUE NOT NULL,
    
    -- Firma Bilgileri
    firma_unvani TEXT NOT NULL,
    vergi_no TEXT NOT NULL,
    vergi_dairesi TEXT NOT NULL,
    ticaret_sicil_no TEXT NOT NULL,
    faaliyet_alani TEXT NOT NULL,
    adres TEXT NOT NULL,
    il TEXT NOT NULL,
    ilce TEXT NOT NULL,
    
    -- İletişim Bilgileri
    yetkili_ad_soyad TEXT NOT NULL,
    telefon TEXT NOT NULL,
    email TEXT NOT NULL,
    alt_telefon TEXT,
    
    -- POS Talep Bilgileri
    pos_adedi INTEGER NOT NULL,
    pos_tipi TEXT NOT NULL,
    aylik_ciro REAL NOT NULL,
    ort_islem_tutari REAL NOT NULL,
    
    -- Durum
    durum TEXT NOT NULL DEFAULT 'alingi',
    durum_aciklama TEXT,
    
    -- Tarihler
    basvuru_tarihi DATETIME DEFAULT CURRENT_TIMESTAMP,
    guncelleme_tarihi DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL,
    belge_tipi TEXT NOT NULL,
    belge_adi TEXT NOT NULL,
    dosya_yolu TEXT NOT NULL,
    orijinal_ad TEXT,
    boyut INTEGER,
    zorunlu INTEGER DEFAULT 1,
    durum TEXT DEFAULT 'yuklendi',
    yukleme_tarihi DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (application_id) REFERENCES applications(id)
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    ad_soyad TEXT NOT NULL,
    aktif INTEGER DEFAULT 1,
    olusturma_tarihi DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER,
    tip TEXT NOT NULL,
    alici TEXT NOT NULL,
    konu TEXT,
    icerik TEXT,
    durum TEXT DEFAULT 'gonderildi',
    hata TEXT,
    gonderim_tarihi DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (application_id) REFERENCES applications(id)
  );

  CREATE TABLE IF NOT EXISTS application_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL,
    admin_id INTEGER,
    not_metni TEXT NOT NULL,
    olusturma_tarihi DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (application_id) REFERENCES applications(id)
  );
`);

// Seed default admin if not exists
const bcrypt = require('bcryptjs');
const adminExists = db.prepare('SELECT id FROM admin_users WHERE email = ?').get('admin@pos.com');
if (!adminExists) {
  const hash = bcrypt.hashSync('Admin123!', 10);
  db.prepare(`INSERT INTO admin_users (email, password_hash, ad_soyad) VALUES (?, ?, ?)`).run('admin@pos.com', hash, 'Sistem Admin');
  console.log('✅ Default admin created: admin@pos.com / Admin123!');
}

// Update schema dynamically for new columns
try {
  db.exec("ALTER TABLE applications ADD COLUMN tabela_adi TEXT DEFAULT ''");
} catch (e) { /* column already exists */ }

try {
  db.exec("ALTER TABLE applications ADD COLUMN sirket_tipi TEXT DEFAULT 'Sahis'");
} catch (e) { /* column already exists */ }

module.exports = db;
