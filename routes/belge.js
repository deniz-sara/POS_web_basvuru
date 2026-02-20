const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../database/db');
const { verifyUploadToken } = require('../middleware/auth');
const { sendEmail, ADMIN_EMAIL } = require('../services/emailService');

const BELGE_TIPLERI = {
    ticari_sicil: 'Ticari Sicil Gazetesi',
    imza_sirkuleri: 'İmza Sirküleri',
    vergi_levhasi: 'Vergi Levhası',
    kimlik_fotokopisi: 'Kimlik Fotokopisi (Yetkili)',
    ikametgah: 'İkametgah Belgesi',
    faaliyet_belgesi: 'Faaliyet Belgesi',
    isyeri_fotografi: 'İşyeri Fotoğrafı',
    kira_tapu: 'Kira Sözleşmesi / Tapu',
    banka_hesabi: 'Banka Hesap Cüzdanı'
};

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '../uploads/pos');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const safe = file.originalname.replace(/[^a-zA-Z0-9.\-]/g, '_');
        cb(null, `${Date.now()}-guncelleme-${safe}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['.pdf', '.jpg', '.jpeg', '.png'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext)) cb(null, true);
        else cb(new Error('Sadece PDF, JPG ve PNG dosyaları kabul edilmektedir.'));
    }
});

// GET /api/pos/belge-info?token= - Token doğrulama ve eksik belge listesi
router.get('/belge-info', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ success: false, message: 'Token gerekli.' });

    const decoded = verifyUploadToken(token);
    if (!decoded || decoded.type !== 'upload') {
        return res.status(403).json({ success: false, message: 'Geçersiz veya süresi dolmuş link.' });
    }

    const app = db.prepare('SELECT id, basvuru_no, firma_unvani, yetkili_ad_soyad, durum FROM applications WHERE id = ?').get(decoded.applicationId);
    if (!app) return res.status(404).json({ success: false, message: 'Başvuru bulunamadı.' });

    const eksikBelgeler = db.prepare("SELECT * FROM documents WHERE application_id = ? AND durum = 'eksik'").all(app.id);

    res.json({
        success: true,
        basvuru: app,
        eksik_belgeler: eksikBelgeler,
        belge_tipleri: BELGE_TIPLERI
    });
});

// POST /api/pos/belge-yukle?token= - Belge yükleme (token ile)
router.post('/belge-yukle', upload.any(), (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ success: false, message: 'Token gerekli.' });

    const decoded = verifyUploadToken(token);
    if (!decoded || decoded.type !== 'upload') {
        return res.status(403).json({ success: false, message: 'Geçersiz veya süresi dolmuş link.' });
    }

    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(decoded.applicationId);
    if (!app) return res.status(404).json({ success: false, message: 'Başvuru bulunamadı.' });

    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ success: false, message: 'Dosya yüklenmedi.' });
    }

    const yuklenenAdlar = [];

    req.files.forEach(file => {
        const belge_tipi = file.fieldname;
        const existing = db.prepare('SELECT id FROM documents WHERE application_id = ? AND belge_tipi = ?').get(app.id, belge_tipi);

        if (existing) {
            db.prepare('UPDATE documents SET dosya_yolu = ?, orijinal_ad = ?, boyut = ?, durum = ?, yukleme_tarihi = CURRENT_TIMESTAMP WHERE id = ?')
                .run(file.path, file.originalname, file.size, 'yuklendi', existing.id);
        } else {
            db.prepare('INSERT INTO documents (application_id, belge_tipi, belge_adi, dosya_yolu, orijinal_ad, boyut, durum) VALUES (?, ?, ?, ?, ?, ?, ?)')
                .run(app.id, belge_tipi, BELGE_TIPLERI[belge_tipi] || belge_tipi, file.path, file.originalname, file.size, 'yuklendi');
        }

        yuklenenAdlar.push(BELGE_TIPLERI[belge_tipi] || belge_tipi);
    });

    // Tüm eksik belgeler tamamlandı mı?
    const kalanEksik = db.prepare("SELECT COUNT(*) as count FROM documents WHERE application_id = ? AND durum = 'eksik'").get(app.id).count;
    if (kalanEksik === 0) {
        db.prepare("UPDATE applications SET durum = 'inceleme', guncelleme_tarihi = CURRENT_TIMESTAMP WHERE id = ?").run(app.id);
    }

    // Admin'e bildirim
    sendEmail(ADMIN_EMAIL, 'belgeYuklendi', {
        firma_unvani: app.firma_unvani,
        basvuru_no: app.basvuru_no,
        yuklenen_belgeler: yuklenenAdlar
    });

    db.prepare("INSERT INTO notifications (application_id, tip, alici, konu, icerik) VALUES (?, ?, ?, ?, ?)")
        .run(app.id, 'email', ADMIN_EMAIL, 'Belge Güncellendi', yuklenenAdlar.join(', '));

    res.json({ success: true, message: 'Belgeler başarıyla yüklendi.', yuklenen: yuklenenAdlar, kalan_eksik: kalanEksik });
});

module.exports = router;
