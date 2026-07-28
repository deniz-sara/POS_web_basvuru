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

const cloudinary = require('cloudinary').v2;
const os = require('os');
const streamifier = require('streamifier');
require('dotenv').config();

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Multer - belge yükleme (Önce RAM'e, sonra upload_stream ile Cloudinary'ye)
const storage = multer.memoryStorage();

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // Reduced to 10MB to avoid OOM on free tier
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

const ZORUNLU_BELGELER = ['ticari_sicil', 'imza_sirkuleri', 'vergi_levhasi', 'kimlik_fotokopisi', 'faaliyet_belgesi', 'kira_tapu', 'banka_hesabi'];

// POST /api/pos/basvuru - Yeni başvuru
router.post('/basvuru', (req, res) => {
    upload.any()(req, res, async (uploadErr) => {
        if (uploadErr) {
            console.error("Multer upload hatası:", uploadErr);
            if (uploadErr.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ success: false, message: 'Yüklenen dosyalardan biri çok büyük (Maksimum 10MB).' });
            }
            return res.status(400).json({ success: false, message: 'Dosya yükleme hatası: ' + uploadErr.message });
        }

        try {
            const {
                firma_unvani, tabela_adi, sirket_tipi, tc_no, vergi_no, vergi_dairesi,
                faaliyet_alani, adres, il, ilce,
                yetkili_ad_soyad, telefon, email, alt_telefon,
                pos_adedi, pos_tipi, aylik_ciro, cihaz_detaylari, website_url, odeme_periyodu
            } = req.body;

            // Zorunlu alan validasyonu
            const zorunlu = { firma_unvani, sirket_tipi, tc_no, vergi_no, vergi_dairesi, faaliyet_alani, adres, il, ilce, yetkili_ad_soyad, telefon, email, pos_tipi, aylik_ciro, odeme_periyodu };
            if (pos_tipi && pos_tipi.includes('Fiziki POS')) {
                zorunlu.pos_adedi = pos_adedi;
            }
            if (pos_tipi && pos_tipi.includes('Sanal POS')) {
                zorunlu.website_url = website_url;
            }
            
            const eksikAlanlar = Object.entries(zorunlu).filter(([k, v]) => !v).map(([k]) => k);
            if (eksikAlanlar.length > 0) {
                return res.status(400).json({ success: false, message: 'Zorunlu alanlar eksik.', eksik: eksikAlanlar });
            }

            // Katı Veri Doğrulama (Strict Validation)
            if (!/^\d{11}$/.test(tc_no)) return res.status(400).json({ success: false, message: 'TC Kimlik No 11 haneli rakam olmalıdır.' });
            if (!/^\d{10}$/.test(vergi_no)) return res.status(400).json({ success: false, message: 'Vergi No 10 haneli rakam olmalıdır.' });
            if (!/^05[0-9]{9}$/.test(telefon)) return res.status(400).json({ success: false, message: 'Telefon 05 ile başlayan 11 haneli rakam olmalıdır.' });
            const emailRegex = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;
            if (!emailRegex.test(email)) return res.status(400).json({ success: false, message: 'Geçersiz e-posta adresi.' });

            // Dinamik Cihaz Detayları JSON Validasyonu
            if (cihaz_detaylari) {
                try {
                    const parsedCihaz = JSON.parse(cihaz_detaylari);
                    if (parsedCihaz.mulkiyet === 'Kendi Cihazim') {
                        for (const c of parsedCihaz.cihazlar) {
                            if (!c.seri_no || c.seri_no.trim() === '') {
                                return res.status(400).json({ success: false, message: 'Kendi cihazını kullanan firmalar her cihaz için Seri No belirtmek zorundadır.' });
                            }
                        }
                    }
                } catch (e) {
                    return res.status(400).json({ success: false, message: 'Geçersiz cihaz veri formatı.' });
                }
            }

            // Yüklenen dosyaları kontrol et
            const yuklenenBelgelerLocals = {};
            if (req.files) {
                req.files.forEach(f => { yuklenenBelgelerLocals[f.fieldname] = f; });
            }

            const eksikZorunlu = ZORUNLU_BELGELER.filter(b => !yuklenenBelgelerLocals[b]);
            if (eksikZorunlu.length > 0) {
                // Hata durumunda geçici dosyaları sil
                if (req.files) req.files.forEach(f => { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); });
                return res.status(400).json({
                    success: false,
                    message: 'Zorunlu belgeler eksik.',
                    eksik_belgeler: eksikZorunlu.map(b => BELGE_TIPLERI[b])
                });
            }

            // Cloudinary'ye paralel yükle
            const yuklenenBelgeler = [];
            if (req.files && req.files.length > 0) {
                try {
                    const uploadPromises = req.files.map(async (f) => {
                        const ext = path.extname(f.originalname).toLowerCase();
                        const safe = path.basename(f.originalname, ext).replace(/[^a-zA-Z0-9.\-]/g, '_');
                        const pubId = `${Date.now()}-${uuidv4().slice(0, 8)}-${safe}`;

                        if (!f.buffer || f.buffer.length === 0 || f.size === 0) {
                            throw new Error(`${f.originalname} isimli dosya boş (0 KB) görünüyor. Lütfen dosyanın bozuk olmadığından emin olun (iCloud veya cihazda tam yüklü olmalı).`);
                        }

                        let finalUrl = '';
                        if (ext === '.pdf') {
                            finalUrl = `data:application/pdf;base64,${f.buffer.toString('base64')}`;
                        } else {
                            finalUrl = await new Promise((resolve, reject) => {
                                const uploadStream = cloudinary.uploader.upload_stream({
                                    folder: 'pos_belgeleri',
                                    resource_type: 'auto',
                                    public_id: pubId
                                }, (error, res) => {
                                    if (error) reject(error);
                                    else resolve(res.secure_url);
                                });
                                streamifier.createReadStream(f.buffer).pipe(uploadStream);
                            });
                        }

                        return {
                            fieldname: f.fieldname,
                            path: finalUrl,
                            originalname: f.originalname,
                            size: f.size
                        };
                    });

                    const uploadResults = await Promise.all(uploadPromises);
                    yuklenenBelgeler.push(...uploadResults);
                } catch (upErr) {
                    console.error("Cloudinary upload hatası:", upErr);
                    return res.status(500).json({ success: false, message: 'Dosya yükleme hatası: ' + (upErr.message || JSON.stringify(upErr)) });
                }
            }

            const basvuruNo = generateBasvuruNo();
            const token = uuidv4();

            // Başvuruyu kaydet
            const stmt = `
      INSERT INTO applications (basvuru_no, token, firma_unvani, tabela_adi, sirket_tipi, tc_no, vergi_no, vergi_dairesi, ticaret_sicil_no,
        faaliyet_alani, adres, il, ilce, yetkili_ad_soyad, telefon, email, alt_telefon,
        pos_adedi, pos_tipi, aylik_ciro, cihaz_detaylari, ort_islem_tutari, website_url, odeme_periyodu)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
      RETURNING id
    `;
            const result = await db.query(stmt, [basvuruNo, token, firma_unvani, tabela_adi || '', sirket_tipi, tc_no, vergi_no, vergi_dairesi, '',
                faaliyet_alani, adres, il, ilce, yetkili_ad_soyad, telefon, email, alt_telefon || null,
                parseInt(pos_adedi) || 0, pos_tipi, parseFloat(aylik_ciro), cihaz_detaylari || null, 0, website_url || null, odeme_periyodu]);

            const applicationId = result.rows[0].id;

            // Belgeleri paralel olarak kaydet (Neon DB ağ gecikmesini engellemek için)
            const docStmt = `
      INSERT INTO documents (application_id, belge_tipi, belge_adi, dosya_yolu, orijinal_ad, boyut, zorunlu)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;
            const docPromises = yuklenenBelgeler.map(file => 
                db.query(docStmt, [applicationId, file.fieldname, BELGE_TIPLERI[file.fieldname] || file.fieldname, file.path, file.originalname, file.size, ZORUNLU_BELGELER.includes(file.fieldname) ? 1 : 0])
            );
            await Promise.all(docPromises);

            // Email & SMS gönder & logla (Arka planda çalışması için await etmeden asenkron IIFE içine alıyoruz)
            (async () => {
                try {
                    const emailData = { basvuru_no: basvuruNo, token, firma_unvani, yetkili_ad_soyad, telefon, email, pos_adedi, pos_tipi, il, ilce };
                    sendEmail(email, 'basvuruAlindiMusteri', emailData).catch(e => console.error('Müşteri email hatası:', e));
                    sendEmail(ADMIN_EMAIL, 'basvuruAlindiAdmin', emailData).catch(e => console.error('Admin email hatası:', e));
                    sendSMS(telefon, smsTemplates.basvuruAlindi(basvuruNo, token)).catch(e => console.error('SMS hatası:', e));

                    // Log notification (Arka planda paralel çalışsın)
                    db.query(`INSERT INTO notifications (application_id, tip, alici, konu, icerik) VALUES ($1, $2, $3, $4, $5)`, [applicationId, 'email', email, 'Başvuru Alındı', basvuruNo]).catch(e => console.error('DB email log hatası:', e));
                    db.query(`INSERT INTO notifications (application_id, tip, alici, konu, icerik) VALUES ($1, $2, $3, $4, $5)`, [applicationId, 'sms', telefon, 'Başvuru Alındı', basvuruNo]).catch(e => console.error('DB sms log hatası:', e));
                } catch (notifErr) {
                    console.error('Bildirim gönderim/log hatası:', notifErr);
                }
            })();

            res.json({ success: true, basvuru_no: basvuruNo, token, message: 'Başvurunuz alındı.' });
        } catch (err) {
            console.error(err);
            res.status(500).json({ success: false, message: 'Sunucu hatası: ' + err.message });
        }
    }); // End of upload wrapper
});

// GET /api/pos/durum/:token - Başvuru durum sorgulama
router.get('/durum/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const appRes = await db.query('SELECT * FROM applications WHERE token = $1', [token]);
        const app = appRes.rows[0];
        if (!app) return res.status(404).json({ success: false, message: 'Başvuru bulunamadı.' });

        const docsRes = await db.query('SELECT belge_tipi, belge_adi, durum, zorunlu, yukleme_tarihi FROM documents WHERE application_id = $1', [app.id]);
        const docs = docsRes.rows;
        const eksikDocs = docs.filter(d => d.durum === 'eksik');

        // Upload token oluştur (belge güncelleme için)
        let uploadToken = null;
        if (eksikDocs.length > 0) {
            uploadToken = generateUploadToken(app.id, eksikDocs.map(d => d.belge_tipi));
        }

        const durumLabels = {
            alindi: 'Başvuru Alındı',
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
                pos_tipi: app.pos_tipi,
                odeme_periyodu: app.odeme_periyodu
            }
        });
    } catch (err) {
        console.error('Durum sorgulama hatası:', err);
        res.status(500).json({ success: false, message: 'Sunucu hatası oluştu.' });
    }
});

// POST /api/pos/sorgula - Başvuru no ve Vergi no ile sorgulama
router.post('/sorgula', async (req, res) => {
    const { basvuru_no, vergi_no } = req.body;

    if (!basvuru_no || !vergi_no) {
        return res.status(400).json({ success: false, message: 'Başvuru Numarası ve Vergi Numarası zorunludur.' });
    }

    try {
        const appRes = await db.query('SELECT token FROM applications WHERE basvuru_no = $1 AND (vergi_no = $2 OR tc_no = $2)', [basvuru_no.trim(), vergi_no.trim()]);
        const app = appRes.rows[0];

        if (!app) {
            return res.status(404).json({ success: false, message: 'Bu bilgilere ait bir başvuru bulunamadı.' });
        }

        res.json({ success: true, token: app.token });
    } catch (err) {
        console.error('Sorgulama hatası:', err);
        res.status(500).json({ success: false, message: 'Sunucu hatası oluştu.' });
    }
});

// GET /api/pos/teklif - Müşteriye teklifi göster
router.get('/teklif', async (req, res) => {
    try {
        const { token } = req.query;
        if (!token) return res.status(400).json({ success: false, message: 'Token gerekli.' });

        const appRes = await db.query('SELECT id, basvuru_no, firma_unvani, durum, teklif_durumu, teklif_detayi, odeme_periyodu FROM applications WHERE token = $1', [token]);
        if (appRes.rows.length === 0) return res.status(404).json({ success: false, message: 'Başvuru bulunamadı.' });

        res.json({ success: true, basvuru: appRes.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Sunucu hatası' });
    }
});

// POST /api/pos/teklif-cevapla - Müşteri teklifi kabul veya reddeder
router.post('/teklif-cevapla', async (req, res) => {
    try {
        const { token, cevap } = req.body;
        if (!token || !cevap) return res.status(400).json({ success: false, message: 'Eksik parametre.' });

        const appRes = await db.query('SELECT * FROM applications WHERE token = $1', [token]);
        const app = appRes.rows[0];
        if (!app) return res.status(404).json({ success: false, message: 'Başvuru bulunamadı.' });

        if (app.teklif_durumu === 'kabul_edildi' || app.teklif_durumu === 'reddedildi') {
            return res.status(400).json({ success: false, message: 'Bu teklife zaten cevap verilmiş.' });
        }

        const yeniDurum = (cevap === 'kabul') ? 'onaylandi' : 'reddedildi';
        const yeniTeklifDurum = (cevap === 'kabul') ? 'kabul_edildi' : 'reddedildi';
        const redEden = (cevap === 'red') ? 'kullanici' : null;

        let extraUpdate = '';
        let extraParams = [];
        let pIndex = 4;
        if (yeniDurum === 'onaylandi') {
            const totalSaat = Math.round((new Date() - new Date(app.basvuru_tarihi)) / 3600000 * 10) / 10;
            extraUpdate = `, sla_toplam_saat = $${pIndex++}, onaylanma_tarihi = CURRENT_TIMESTAMP`;
            extraParams.push(totalSaat);
        } else if (yeniDurum === 'reddedildi') {
            extraUpdate = `, red_eden = $${pIndex++}`;
            extraParams.push(redEden);
        }

        await db.query(`UPDATE applications SET durum = $1, teklif_durumu = $2, guncelleme_tarihi = CURRENT_TIMESTAMP${extraUpdate} WHERE id = $3`, [yeniDurum, yeniTeklifDurum, app.id, ...extraParams]);

        // SLA Update
        const activeHistoryRes = await db.query('SELECT id, baslangic_tarihi FROM status_history WHERE application_id = $1 AND bitis_tarihi IS NULL ORDER BY id DESC LIMIT 1', [app.id]);
        const activeHistory = activeHistoryRes.rows[0];
        if (activeHistory) {
            const baslangic = new Date(activeHistory.baslangic_tarihi);
            const simdi = new Date();
            const gecenDakika = Math.round((simdi - baslangic) / 60000);
            await db.query('UPDATE status_history SET bitis_tarihi = CURRENT_TIMESTAMP, gecen_sure_dk = $1 WHERE id = $2', [gecenDakika, activeHistory.id]);
        }
        await db.query('INSERT INTO status_history (application_id, durum) VALUES ($1, $2)', [app.id, yeniDurum]);

        res.json({ success: true, message: 'Cevabınız kaydedildi.' });

    } catch (err) {
        res.status(500).json({ success: false, message: 'Sunucu hatası' });
    }
});

module.exports = router;
