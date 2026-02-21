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

const cloudinary = require('cloudinary').v2;
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const streamifier = require('streamifier');
require('dotenv').config();

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = multer.memoryStorage();

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
router.get('/belge-info', async (req, res) => {
    try {
        const { token } = req.query;
        if (!token) return res.status(400).json({ success: false, message: 'Token gerekli.' });

        const decoded = verifyUploadToken(token);
        if (!decoded || decoded.type !== 'upload') {
            return res.status(403).json({ success: false, message: 'Geçersiz veya süresi dolmuş link.' });
        }

        const appRes = await db.query('SELECT id, basvuru_no, firma_unvani, yetkili_ad_soyad, durum FROM applications WHERE id = $1', [decoded.applicationId]);
        const app = appRes.rows[0];
        if (!app) return res.status(404).json({ success: false, message: 'Başvuru bulunamadı.' });

        const eksikBelgelerRes = await db.query("SELECT * FROM documents WHERE application_id = $1 AND durum = 'eksik'", [app.id]);

        res.json({
            success: true,
            basvuru: app,
            eksik_belgeler: eksikBelgelerRes.rows,
            belge_tipleri: BELGE_TIPLERI
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Sunucu hatası' });
    }
});

// POST /api/pos/belge-yukle?token= - Belge yükleme (token ile)
router.post('/belge-yukle', upload.any(), async (req, res) => {
    try {
        const { token } = req.query;
        if (!token) return res.status(400).json({ success: false, message: 'Token gerekli.' });

        const decoded = verifyUploadToken(token);
        if (!decoded || decoded.type !== 'upload') {
            return res.status(403).json({ success: false, message: 'Geçersiz veya süresi dolmuş link.' });
        }

        const appRes = await db.query('SELECT * FROM applications WHERE id = $1', [decoded.applicationId]);
        const app = appRes.rows[0];
        if (!app) return res.status(404).json({ success: false, message: 'Başvuru bulunamadı.' });

        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, message: 'Dosya yüklenmedi.' });
        }

        const yuklenenAdlar = [];

        for (const file of req.files) {
            const belge_tipi = file.fieldname;
            const ext = path.extname(file.originalname);
            const safe = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9.\-]/g, '_');
            const pubId = `${Date.now()}-guncelleme-${safe}${ext}`;

            let secureUrl = '';
            try {
                if (!file.buffer || file.buffer.length === 0 || file.size === 0) {
                    return res.status(400).json({ success: false, message: `${file.originalname} isimli dosya boş (0 KB) görünüyor. Lütfen dosyanın bozuk olmadığından emin olun.` });
                }

                const result = await new Promise((resolve, reject) => {
                    const uploadStream = cloudinary.uploader.upload_stream({
                        folder: 'pos_guncellemeleri',
                        resource_type: 'raw',
                        public_id: pubId
                    }, (error, res) => {
                        if (error) reject(error);
                        else resolve(res);
                    });
                    streamifier.createReadStream(file.buffer).pipe(uploadStream);
                });
                secureUrl = result.secure_url;
            } catch (upErr) {
                console.error("Cloudinary upload hatası (belge):", upErr);
                return res.status(500).json({ success: false, message: 'Hata detayı: ' + (upErr.message || JSON.stringify(upErr)) });
            }

            const existingRes = await db.query('SELECT id FROM documents WHERE application_id = $1 AND belge_tipi = $2', [app.id, belge_tipi]);
            const existing = existingRes.rows[0];

            if (existing) {
                await db.query('UPDATE documents SET dosya_yolu = $1, orijinal_ad = $2, boyut = $3, durum = $4, yukleme_tarihi = CURRENT_TIMESTAMP WHERE id = $5',
                    [secureUrl, file.originalname, file.size, 'yuklendi', existing.id]);
            } else {
                await db.query('INSERT INTO documents (application_id, belge_tipi, belge_adi, dosya_yolu, orijinal_ad, boyut, durum) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                    [app.id, belge_tipi, BELGE_TIPLERI[belge_tipi] || belge_tipi, secureUrl, file.originalname, file.size, 'yuklendi']);
            }

            yuklenenAdlar.push(BELGE_TIPLERI[belge_tipi] || belge_tipi);
        }

        // Tüm eksik belgeler tamamlandı mı?
        const kalanEksikRes = await db.query("SELECT COUNT(*) as count FROM documents WHERE application_id = $1 AND durum = 'eksik'", [app.id]);
        const kalanEksik = parseInt(kalanEksikRes.rows[0].count);

        if (kalanEksik === 0) {
            await db.query("UPDATE applications SET durum = 'inceleme', guncelleme_tarihi = CURRENT_TIMESTAMP WHERE id = $1", [app.id]);
        }

        // Admin'e bildirim
        sendEmail(ADMIN_EMAIL, 'belgeYuklendi', {
            firma_unvani: app.firma_unvani,
            basvuru_no: app.basvuru_no,
            yuklenen_belgeler: yuklenenAdlar
        });

        await db.query("INSERT INTO notifications (application_id, tip, alici, konu, icerik) VALUES ($1, $2, $3, $4, $5)",
            [app.id, 'email', ADMIN_EMAIL, 'Belge Güncellendi', yuklenenAdlar.join(', ')]);

        res.json({ success: true, message: 'Belgeler başarıyla yüklendi.', yuklenen: yuklenenAdlar, kalan_eksik: kalanEksik });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Sunucu hatası' });
    }
});

module.exports = router;
