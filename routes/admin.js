const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../database/db');
const bcrypt = require('bcryptjs');
const { authMiddleware, generateToken, generateUploadToken } = require('../middleware/auth');
const { sendEmail, ADMIN_EMAIL } = require('../services/emailService');
const { sendSMS, smsTemplates } = require('../services/smsService');

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

const DURUM_LABELS = {
    alingi: 'Başvuru Alındı',
    inceleme: 'Evrak İnceleme',
    degerlendirme: 'Değerlendirme',
    onaylandi: 'Onaylandı',
    reddedildi: 'Reddedildi',
    ek_bilgi: 'Ek Bilgi / Evrak Bekleniyor'
};

// POST /api/admin/login
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email ve şifre gerekli.' });

    try {
        const userRes = await db.query('SELECT * FROM admin_users WHERE email = $1 AND aktif = 1', [email]);
        const user = userRes.rows[0];
        if (!user || !bcrypt.compareSync(password, user.password_hash)) {
            return res.status(401).json({ success: false, message: 'Email veya şifre hatalı.' });
        }

        const token = generateToken({ id: user.id, email: user.email, ad_soyad: user.ad_soyad });
        res.json({ success: true, token, admin: { id: user.id, email: user.email, ad_soyad: user.ad_soyad } });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Sunucu hatası' });
    }
});

// GET /api/admin/basvurular - Tüm başvurular (filtreleme destekli)
router.get('/basvurular', authMiddleware, async (req, res) => {
    try {
        let query = `
        SELECT a.*,
          COUNT(d.id) as toplam_belge,
          SUM(CASE WHEN d.durum = 'eksik' THEN 1 ELSE 0 END) as eksik_belge
        FROM applications a
        LEFT JOIN documents d ON a.id = d.application_id
        WHERE 1=1
      `;
        const params = [];
        let paramCount = 1;

        if (req.query.durum) { query += ` AND a.durum = $${paramCount++}`; params.push(req.query.durum); }
        if (req.query.il) { query += ` AND a.il = $${paramCount++}`; params.push(req.query.il); }
        if (req.query.basvuru_no) { query += ` AND a.basvuru_no ILIKE $${paramCount++}`; params.push(`%${req.query.basvuru_no}%`); }
        if (req.query.firma) { query += ` AND a.firma_unvani ILIKE $${paramCount++}`; params.push(`%${req.query.firma}%`); }
        if (req.query.tarih_baslangic) { query += ` AND a.basvuru_tarihi >= $${paramCount++}`; params.push(req.query.tarih_baslangic); }
        if (req.query.tarih_bitis) { query += ` AND a.basvuru_tarihi <= $${paramCount++}`; params.push(req.query.tarih_bitis + ' 23:59:59'); }

        query += ' GROUP BY a.id ORDER BY a.basvuru_tarihi DESC';

        if (req.query.limit) { query += ` LIMIT $${paramCount++}`; params.push(parseInt(req.query.limit)); }

        const basvurularRes = await db.query(query, params);
        res.json({ success: true, data: basvurularRes.rows, toplam: basvurularRes.rows.length });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Sunucu hatası' });
    }
});

// GET /api/admin/basvuru/:id - Tekil başvuru detay
router.get('/basvuru/:id', authMiddleware, async (req, res) => {
    try {
        const appRes = await db.query('SELECT * FROM applications WHERE id = $1', [req.params.id]);
        const app = appRes.rows[0];
        if (!app) return res.status(404).json({ success: false, message: 'Başvuru bulunamadı.' });

        const docsRes = await db.query(`
            SELECT id, application_id, belge_tipi, belge_adi, orijinal_ad, boyut, durum, yukleme_tarihi,
            CASE WHEN dosya_yolu LIKE 'data:%' THEN '/api/admin/dosya-indir/' || id ELSE dosya_yolu END as dosya_yolu
            FROM documents WHERE application_id = $1
        `, [app.id]);
        const notesRes = await db.query('SELECT n.*, u.ad_soyad FROM application_notes n LEFT JOIN admin_users u ON n.admin_id = u.id WHERE n.application_id = $1 ORDER BY n.olusturma_tarihi DESC', [app.id]);

        res.json({ success: true, basvuru: app, belgeler: docsRes.rows, notlar: notesRes.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Sunucu hatası' });
    }
});

// GET /api/admin/dosya-indir/:id - Veritabanındaki Base64 dosyayı indir
router.get('/dosya-indir/:id', authMiddleware, async (req, res) => {
    try {
        const docRes = await db.query('SELECT dosya_yolu, orijinal_ad FROM documents WHERE id = $1', [req.params.id]);
        const doc = docRes.rows[0];
        if (!doc || !doc.dosya_yolu || !doc.dosya_yolu.startsWith('data:')) {
            return res.status(404).send('Dosya bulunamadı veya bulutta saklanıyor.');
        }

        const matches = doc.dosya_yolu.match(/^data:(.+?);base64,(.*)$/);
        if (!matches || matches.length !== 3) {
            return res.status(400).send('Geçersiz dosya verisi.');
        }

        const mimeType = matches[1];
        const buffer = Buffer.from(matches[2], 'base64');

        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.orijinal_ad)}"`);
        res.send(buffer);
    } catch (err) {
        res.status(500).send('Sunucu hatası');
    }
});

// PUT /api/admin/basvuru/:id/durum - Durum güncelle
router.put('/basvuru/:id/durum', authMiddleware, async (req, res) => {
    try {
        const { durum, aciklama } = req.body;
        const appRes = await db.query('SELECT * FROM applications WHERE id = $1', [req.params.id]);
        const app = appRes.rows[0];
        if (!app) return res.status(404).json({ success: false, message: 'Başvuru bulunamadı.' });

        await db.query(`UPDATE applications SET durum = $1, durum_aciklama = $2, guncelleme_tarihi = CURRENT_TIMESTAMP WHERE id = $3`, [durum, aciklama || null, app.id]);

        // Bildirim gönder
        const emailData = { basvuru_no: app.basvuru_no, token: app.token, yetkili_ad_soyad: app.yetkili_ad_soyad, yeni_durum_label: DURUM_LABELS[durum] || durum, aciklama };
        sendEmail(app.email, 'durumGuncellendi', emailData);
        sendSMS(app.telefon, smsTemplates.durumGuncellendi(app.basvuru_no, DURUM_LABELS[durum] || durum));

        await db.query(`INSERT INTO notifications (application_id, tip, alici, konu, icerik) VALUES ($1, $2, $3, $4, $5)`, [app.id, 'email', app.email, 'Durum Güncellendi', durum]);

        res.json({ success: true, message: 'Durum güncellendi.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Sunucu hatası' });
    }
});

// PUT /api/admin/basvuru/:id/eksik-evrak - Eksik evrak işaretle + bildirim
router.put('/basvuru/:id/eksik-evrak', authMiddleware, async (req, res) => {
    try {
        const { eksik_belgeler, aciklama } = req.body;
        const appRes = await db.query('SELECT * FROM applications WHERE id = $1', [req.params.id]);
        const app = appRes.rows[0];
        if (!app) return res.status(404).json({ success: false, message: 'Başvuru bulunamadı.' });

        // Belgeleri eksik olarak işaretle
        for (const belge_tipi of eksik_belgeler) {
            const existingRes = await db.query('SELECT id FROM documents WHERE application_id = $1 AND belge_tipi = $2', [app.id, belge_tipi]);
            const existing = existingRes.rows[0];
            if (existing) {
                await db.query('UPDATE documents SET durum = $1 WHERE id = $2', ['eksik', existing.id]);
            } else {
                // Belge hiç yüklenmemiş - kayıt oluştur
                await db.query('INSERT INTO documents (application_id, belge_tipi, belge_adi, dosya_yolu, durum) VALUES ($1, $2, $3, $4, $5)', [app.id, belge_tipi, BELGE_TIPLERI[belge_tipi] || belge_tipi, '', 'eksik']);
            }
        }

        // Durum güncelle
        await db.query('UPDATE applications SET durum = $1, durum_aciklama = $2, guncelleme_tarihi = CURRENT_TIMESTAMP WHERE id = $3', ['ek_bilgi', aciklama || null, app.id]);

        // Upload token oluştur
        const uploadToken = generateUploadToken(app.id, eksik_belgeler);

        // Bildirim gönder
        const emailData = {
            basvuru_no: app.basvuru_no,
            yetkili_ad_soyad: app.yetkili_ad_soyad,
            eksik_belgeler: eksik_belgeler.map(b => BELGE_TIPLERI[b] || b),
            upload_token: uploadToken,
            aciklama
        };
        sendEmail(app.email, 'eksikEvrak', emailData);
        sendSMS(app.telefon, smsTemplates.eksikEvrak(app.basvuru_no, uploadToken));

        await db.query(`INSERT INTO notifications (application_id, tip, alici, konu, icerik) VALUES ($1, $2, $3, $4, $5)`, [app.id, 'email', app.email, 'Eksik Evrak', eksik_belgeler.join(', ')]);

        res.json({ success: true, message: 'Eksik evrak bildirimi gönderildi.', upload_token: uploadToken });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Sunucu hatası' });
    }
});

// POST /api/admin/basvuru/:id/not - Not ekle
router.post('/basvuru/:id/not', authMiddleware, async (req, res) => {
    try {
        const { not_metni } = req.body;
        await db.query('INSERT INTO application_notes (application_id, admin_id, not_metni) VALUES ($1, $2, $3)', [req.params.id, req.admin.id, not_metni]);
        res.json({ success: true, message: 'Not eklendi.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Sunucu hatası' });
    }
});

const xlsx = require('xlsx');

// GET /api/admin/export - XLSX export
router.get('/export', authMiddleware, async (req, res) => {
    try {
        const basvurularRes = await db.query('SELECT * FROM applications ORDER BY basvuru_tarihi DESC');
        const basvurular = basvurularRes.rows;

        const durumLabels = {
            alingi: 'Başvuru Alındı',
            inceleme: 'Evrak İnceleme',
            degerlendirme: 'Değerlendirme',
            ek_bilgi: 'Evrak Bekleniyor',
            onaylandi: 'Onaylandı',
            reddedildi: 'Reddedildi'
        };

        const formattedData = basvurular.map(b => {
            let cihazlarStr = '';
            if (b.cihaz_detaylari) {
                try {
                    const parsed = JSON.parse(b.cihaz_detaylari);
                    const isOwn = parsed.mulkiyet === 'Kendi Cihazim';
                    const prefix = isOwn ? '[Müşteriye Ait] ' : '[QNBpay Cihaz Talebi] ';
                    if (parsed.cihazlar && parsed.cihazlar.length > 0) {
                        cihazlarStr = prefix + parsed.cihazlar.map(c => {
                            let parts = [`Cihaz ${c.index}: ${c.adres} (${c.ilce}/${c.il})`];
                            if (c.seri_no) parts.push(`Seri No: ${c.seri_no}`);
                            return parts.join(' - ');
                        }).join(' | ');
                    }
                } catch (e) {
                    cihazlarStr = 'Format Hatası';
                }
            }

            return {
                'Başvuru No': b.basvuru_no,
                'Firma Unvanı': b.firma_unvani,
                'TC No': b.tc_no || '-',
                'Vergi No': b.vergi_no || '-',
                'Yetkili': b.yetkili_ad_soyad,
                'Telefon': b.telefon,
                'Email': b.email,
                'İl': b.il,
                'POS Adedi': b.pos_adedi,
                'Cihaz Detayları': cihazlarStr,
                'Tahmini Ciro': b.aylik_ciro,
                'Durum': durumLabels[b.durum] || b.durum,
                'Tarih': b.basvuru_tarihi
            };
        });

        const worksheet = xlsx.utils.json_to_sheet(formattedData);
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, worksheet, "Başvurular");

        const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="pos-basvurular-${Date.now()}.xlsx"`);
        res.send(buffer);
    } catch (err) {
        res.status(500).json({ success: false, message: 'Sunucu hatası' });
    }
});

// GET /api/admin/stats - İstatistikler
router.get('/stats', authMiddleware, async (req, res) => {
    try {
        const toplamRes = await db.query('SELECT COUNT(*) as count FROM applications');
        const durumlarRes = await db.query('SELECT durum, COUNT(*) as count FROM applications GROUP BY durum');
        const bugunRes = await db.query("SELECT COUNT(*) as count FROM applications WHERE basvuru_tarihi >= CURRENT_DATE");
        const illerRes = await db.query("SELECT DISTINCT il FROM applications WHERE il IS NOT NULL ORDER BY il");

        res.json({
            success: true,
            toplam: parseInt(toplamRes.rows[0].count),
            bugun: parseInt(bugunRes.rows[0].count),
            durumlar: durumlarRes.rows.map(d => ({ durum: d.durum, count: parseInt(d.count) })),
            iller: illerRes.rows.map(r => r.il).filter(i => i.trim() !== '')
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Sunucu hatası' });
    }
});

// GET /api/admin/users - Tüm yöneticiler
router.get('/users', authMiddleware, async (req, res) => {
    try {
        const usersRes = await db.query('SELECT id, email, ad_soyad, aktif, olusturma_tarihi FROM admin_users');
        res.json({ success: true, data: usersRes.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Sunucu hatası' });
    }
});

// POST /api/admin/user - Yeni yönetici ekle
router.post('/user', authMiddleware, async (req, res) => {
    const { email, password, ad_soyad } = req.body;
    if (!email || !password || !ad_soyad) {
        return res.status(400).json({ success: false, message: 'Tüm alanlar zorunludur.' });
    }

    try {
        const hash = bcrypt.hashSync(password, 10);
        await db.query('INSERT INTO admin_users (email, password_hash, ad_soyad) VALUES ($1, $2, $3)', [email, hash, ad_soyad]);
        res.json({ success: true, message: 'Kullanıcı başarıyla oluşturuldu.' });
    } catch (err) {
        if (err.message.includes('unique constraint')) {
            return res.status(400).json({ success: false, message: 'Bu email adresi zaten kullanımda.' });
        }
        res.status(500).json({ success: false, message: 'Kullanıcı eklenirken hata oluştu.' });
    }
});

// PUT /api/admin/user/:id - Yönetici düzenle
router.put('/user/:id', authMiddleware, async (req, res) => {
    const { email, password, ad_soyad } = req.body;
    const { id } = req.params;

    if (!email || !ad_soyad) {
        return res.status(400).json({ success: false, message: 'Email ve Ad Soyad zorunludur.' });
    }

    try {
        if (password) {
            const hash = bcrypt.hashSync(password, 10);
            await db.query('UPDATE admin_users SET email = $1, ad_soyad = $2, password_hash = $3 WHERE id = $4', [email, ad_soyad, hash, id]);
        } else {
            await db.query('UPDATE admin_users SET email = $1, ad_soyad = $2 WHERE id = $3', [email, ad_soyad, id]);
        }
        res.json({ success: true, message: 'Kullanıcı başarıyla güncellendi.' });
    } catch (err) {
        if (err.code === '23505' || (err.message && err.message.includes('unique constraint'))) {
            return res.status(400).json({ success: false, message: 'Bu email zaten kullanımda.' });
        }
        res.status(500).json({ success: false, message: 'Sunucu hatası' });
    }
});

// PUT /api/admin/user/:id/status - Yönetici durumunu değiştir (aktif/pasif)
router.put('/user/:id/status', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { aktif } = req.body;

    if (id == req.admin.id) {
        return res.status(400).json({ success: false, message: 'Kendi hesabınızı pasif yapamazsınız.' });
    }

    try {
        await db.query('UPDATE admin_users SET aktif = $1 WHERE id = $2', [aktif ? 1 : 0, id]);
        res.json({ success: true, message: 'Kullanıcı durumu güncellendi.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Sunucu hatası' });
    }
});

// Dosyalara erişim endpoint'i (admin)
router.get('/dosya/:filename', authMiddleware, (req, res) => {
    const filePath = path.join(__dirname, '../uploads/pos', req.params.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, message: 'Dosya bulunamadı.' });
    res.sendFile(filePath);
});

module.exports = router;
