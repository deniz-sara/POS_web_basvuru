const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('../database/db');
const { sendEmail, ADMIN_EMAIL } = require('../services/emailService');
const { sendSMS, smsTemplates } = require('../services/smsService');
const { generateUploadToken } = require('../middleware/auth');

// Multer - belge yükleme (başvuru sırasında)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '../uploads/pos');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const safe = file.originalname.replace(/[^a-zA-Z0-9.\-]/g, '_');
        cb(null, `${Date.now()}-${uuidv4().slice(0, 8)}-${safe}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
    fileFilter: (req, file, cb) => {
        const allowed = ['.pdf', '.jpg', '.jpeg', '.png'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext)) cb(null, true);
        else cb(new Error('Sadece PDF, JPG ve PNG dosyaları kabul edilmektedir.'));
    }
});

// Başvuru no üretici
function generateBasvuruNo() {
    const now = new Date();
    const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const random = Math.floor(10000 + Math.random() * 90000);
    return `POS-${yyyymm}-${random}`;
}

const BELGE_TIPLERI = {
    ticari_sicil: 'Ticari Sicil Gazetesi',
    imza_sirkuleri: 'İmza Sirküleri',
    vergi_levhasi: 'Vergi Levhası',
    kimlik_fotokopisi: 'Kimlik Fotokopisi (Yetkili)',
    ikametgah: 'İkametgah Belgesi',
    faaliyet_belgesi: 'Faaliyet Belgesi',
    gmu_muafiyet: 'GMU ve Muafiyet Belgesi',
    kira_tapu: 'QNBpay Sözleşme',
    banka_hesabi: 'Banka Hesap Cüzdanı'
};

const ZORUNLU_BELGELER = ['ticari_sicil', 'imza_sirkuleri', 'vergi_levhasi', 'kimlik_fotokopisi', 'ikametgah', 'faaliyet_belgesi'];

// POST /api/pos/basvuru - Yeni başvuru
router.post('/basvuru', upload.any(), async (req, res) => {
    try {
        const {
            firma_unvani, tabela_adi, sirket_tipi, vergi_no, vergi_dairesi, ticaret_sicil_no,
            faaliyet_alani, adres, il, ilce,
            yetkili_ad_soyad, telefon, email, alt_telefon,
            pos_adedi, pos_tipi, aylik_ciro, ort_islem_tutari
        } = req.body;

        // Zorunlu alan validasyonu
        const zorunlu = { firma_unvani, sirket_tipi, vergi_no, vergi_dairesi, ticaret_sicil_no, faaliyet_alani, adres, il, ilce, yetkili_ad_soyad, telefon, email, pos_adedi, pos_tipi, aylik_ciro, ort_islem_tutari };
        const eksikAlanlar = Object.entries(zorunlu).filter(([k, v]) => !v).map(([k]) => k);
        if (eksikAlanlar.length > 0) {
            return res.status(400).json({ success: false, message: 'Zorunlu alanlar eksik.', eksik: eksikAlanlar });
        }

        // Yüklenen dosyaları kontrol et
        const yuklenenBelgeler = {};
        if (req.files) {
            req.files.forEach(f => { yuklenenBelgeler[f.fieldname] = f; });
        }

        const eksikZorunlu = ZORUNLU_BELGELER.filter(b => !yuklenenBelgeler[b]);
        if (eksikZorunlu.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Zorunlu belgeler eksik.',
                eksik_belgeler: eksikZorunlu.map(b => BELGE_TIPLERI[b])
            });
        }

        const basvuruNo = generateBasvuruNo();
        const token = uuidv4();

        // Başvuruyu kaydet
        const stmt = db.prepare(`
      INSERT INTO applications (basvuru_no, token, firma_unvani, tabela_adi, sirket_tipi, vergi_no, vergi_dairesi, ticaret_sicil_no,
        faaliyet_alani, adres, il, ilce, yetkili_ad_soyad, telefon, email, alt_telefon,
        pos_adedi, pos_tipi, aylik_ciro, ort_islem_tutari)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        const result = stmt.run(basvuruNo, token, firma_unvani, tabela_adi || '', sirket_tipi, vergi_no, vergi_dairesi, ticaret_sicil_no,
            faaliyet_alani, adres, il, ilce, yetkili_ad_soyad, telefon, email, alt_telefon || null,
            parseInt(pos_adedi), pos_tipi, parseFloat(aylik_ciro), parseFloat(ort_islem_tutari));

        const applicationId = result.lastInsertRowid;

        // Belgeleri kaydet
        const docStmt = db.prepare(`
      INSERT INTO documents (application_id, belge_tipi, belge_adi, dosya_yolu, orijinal_ad, boyut, zorunlu)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
        Object.entries(yuklenenBelgeler).forEach(([tip, file]) => {
            docStmt.run(applicationId, tip, BELGE_TIPLERI[tip] || tip, file.path, file.originalname, file.size, ZORUNLU_BELGELER.includes(tip) ? 1 : 0);
        });

        // Email & SMS gönder (async)
        const emailData = { basvuru_no: basvuruNo, token, firma_unvani, yetkili_ad_soyad, telefon, email, pos_adedi, pos_tipi, il, ilce };
        sendEmail(email, 'basvuruAlindiMusteri', emailData);
        sendEmail(ADMIN_EMAIL, 'basvuruAlindiAdmin', emailData);
        sendSMS(telefon, smsTemplates.basvuruAlindi(basvuruNo, token));

        // Log notification
        db.prepare(`INSERT INTO notifications (application_id, tip, alici, konu, icerik) VALUES (?, ?, ?, ?, ?)`).run(applicationId, 'email', email, 'Başvuru Alındı', basvuruNo);
        db.prepare(`INSERT INTO notifications (application_id, tip, alici, konu, icerik) VALUES (?, ?, ?, ?, ?)`).run(applicationId, 'sms', telefon, 'Başvuru Alındı', basvuruNo);

        res.json({ success: true, basvuru_no: basvuruNo, token, message: 'Başvurunuz alındı.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Sunucu hatası: ' + err.message });
    }
});

// GET /api/pos/durum/:token - Başvuru durum sorgulama
router.get('/durum/:token', (req, res) => {
    const { token } = req.params;
    const app = db.prepare('SELECT * FROM applications WHERE token = ?').get(token);
    if (!app) return res.status(404).json({ success: false, message: 'Başvuru bulunamadı.' });

    const docs = db.prepare('SELECT belge_tipi, belge_adi, durum, zorunlu, yukleme_tarihi FROM documents WHERE application_id = ?').all(app.id);
    const eksikDocs = docs.filter(d => d.durum === 'eksik');

    // Upload token oluştur (belge güncelleme için)
    let uploadToken = null;
    if (eksikDocs.length > 0) {
        uploadToken = generateUploadToken(app.id, eksikDocs.map(d => d.belge_tipi));
    }

    const durumLabels = {
        alingi: 'Başvuru Alındı',
        inceleme: 'Evrak İnceleme',
        degerlendirme: 'Değerlendirme',
        onaylandi: 'Onaylandı',
        reddedildi: 'Reddedildi',
        ek_bilgi: 'Ek Bilgi / Evrak Bekleniyor'
    };

    res.json({
        success: true,
        basvuru: {
            basvuru_no: app.basvuru_no,
            firma_unvani: app.firma_unvani,
            yetkili_ad_soyad: app.yetkili_ad_soyad,
            durum: app.durum,
            durum_label: durumLabels[app.durum] || app.durum,
            durum_aciklama: app.durum_aciklama,
            basvuru_tarihi: app.basvuru_tarihi,
            guncelleme_tarihi: app.guncelleme_tarihi,
            belgeler: docs,
            eksik_belgeler: eksikDocs,
            upload_token: uploadToken,
            pos_adedi: app.pos_adedi,
            pos_tipi: app.pos_tipi
        }
    });
});

// POST /api/pos/sorgula - Başvuru no ve Vergi no ile sorgulama
router.post('/sorgula', (req, res) => {
    const { basvuru_no, vergi_no } = req.body;

    if (!basvuru_no || !vergi_no) {
        return res.status(400).json({ success: false, message: 'Başvuru Numarası ve Vergi Numarası zorunludur.' });
    }

    try {
        const app = db.prepare('SELECT token FROM applications WHERE basvuru_no = ? AND (vergi_no = ? OR ticaret_sicil_no = ?)').get(basvuru_no.trim(), vergi_no.trim(), vergi_no.trim());

        if (!app) {
            return res.status(404).json({ success: false, message: 'Bu bilgilere ait bir başvuru bulunamadı.' });
        }

        res.json({ success: true, token: app.token });
    } catch (err) {
        console.error('Sorgulama hatası:', err);
        res.status(500).json({ success: false, message: 'Sunucu hatası oluştu.' });
    }
});

module.exports = router;
