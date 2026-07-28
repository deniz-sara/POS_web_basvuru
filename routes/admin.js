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
    alindi: 'Başvuru Alındı',
    inceleme: 'Evrak İnceleme',
    degerlendirme: 'Değerlendirmede',
    teklif_bekleniyor: 'Teklif İletildi (Müşteri Onayı)',
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

        await db.query('UPDATE admin_users SET son_giris_tarihi = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);
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
          SUM(CASE WHEN d.durum = 'eksik' THEN 1 ELSE 0 END) as eksik_belge,
          COALESCE(a.sla_toplam_saat, ROUND((EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - a.basvuru_tarihi)) / 3600.0)::numeric, 1)) as guncel_sla,
          CASE WHEN a.durum IN ('onaylandi', 'reddedildi') THEN 0 ELSE ROUND((EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - COALESCE(a.guncelleme_tarihi, a.basvuru_tarihi))) / 3600.0)::numeric, 1) END as mevcut_durum_saat
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
        if (req.query.tarih_baslangic) { query += ` AND (a.basvuru_tarihi AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Istanbul')::date >= $${paramCount++}::date`; params.push(req.query.tarih_baslangic); }
        if (req.query.tarih_bitis) { query += ` AND (a.basvuru_tarihi AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Istanbul')::date <= $${paramCount++}::date`; params.push(req.query.tarih_bitis); }
        if (req.query.pos_tipi) { query += ` AND a.pos_tipi ILIKE $${paramCount++}`; params.push(`%${req.query.pos_tipi}%`); }
        if (req.query.sla_gecen === 'true') {
            query += ` AND COALESCE(a.sla_toplam_saat, ROUND((EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - a.basvuru_tarihi)) / 3600.0)::numeric, 1)) > 24 AND a.durum NOT IN ('onaylandi', 'reddedildi')`;
        }

        if (req.query.sort === 'sla_desc') {
            query += ' GROUP BY a.id ORDER BY a.sla_toplam_saat DESC NULLS LAST, a.basvuru_tarihi ASC';
        } else {
            query += ' GROUP BY a.id ORDER BY a.basvuru_tarihi DESC';
        }

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
        const historyRes = await db.query('SELECT * FROM status_history WHERE application_id = $1 ORDER BY id ASC', [app.id]);

        res.json({ success: true, basvuru: app, belgeler: docsRes.rows, notlar: notesRes.rows, history: historyRes.rows });
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

        // SLA / History Logic
        if (app.durum !== durum) {
            const activeHistoryRes = await db.query('SELECT id, baslangic_tarihi FROM status_history WHERE application_id = $1 AND bitis_tarihi IS NULL ORDER BY id DESC LIMIT 1', [app.id]);
            const activeHistory = activeHistoryRes.rows[0];
            if (activeHistory) {
                const baslangic = new Date(activeHistory.baslangic_tarihi);
                const simdi = new Date();
                const gecenDakika = Math.round((simdi - baslangic) / 60000);
                await db.query('UPDATE status_history SET bitis_tarihi = CURRENT_TIMESTAMP, gecen_sure_dk = $1 WHERE id = $2', [gecenDakika, activeHistory.id]);
            }
            await db.query('INSERT INTO status_history (application_id, durum) VALUES ($1, $2)', [app.id, durum]);
        }
        
        let extraUpdate = '';
        let extraParams = [];
        let pIndex = 4;
        if ((durum === 'onaylandi' || durum === 'reddedildi') && app.durum !== 'onaylandi' && app.durum !== 'reddedildi') {
            const totalSaat = Math.round((new Date() - new Date(app.basvuru_tarihi)) / 3600000 * 10) / 10;
            extraUpdate = `, sla_toplam_saat = $${pIndex++}`;
            extraParams.push(totalSaat);
            
            if (durum === 'onaylandi') {
                extraUpdate += `, onaylanma_tarihi = CURRENT_TIMESTAMP`;
            } else if (durum === 'reddedildi') {
                extraUpdate += `, red_eden = $${pIndex++}`;
                extraParams.push('yonetici');
            }
        } else if (durum === 'reddedildi') {
            extraUpdate = `, red_eden = $${pIndex++}`;
            extraParams.push('yonetici');
        }

        await db.query(`UPDATE applications SET durum = $1, durum_aciklama = $2, guncelleme_tarihi = CURRENT_TIMESTAMP${extraUpdate} WHERE id = $3`, [durum, aciklama || null, app.id, ...extraParams]);

        await db.query(`INSERT INTO admin_logs (admin_id, islem_tipi, basvuru_id, detay) VALUES ($1, $2, $3, $4)`,
            [req.admin.id, 'Durum Güncelleme', app.id, `Durum '${DURUM_LABELS[durum] || durum}' olarak güncellendi. ${aciklama ? 'Not: ' + aciklama : ''}`]);

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

// PUT /api/admin/basvuru/:id/teklif-ilet - Fiyat Teklifi İlet
router.put('/basvuru/:id/teklif-ilet', authMiddleware, async (req, res) => {
    try {
        let { odeme_periyodu, teklif_detayi, aciklama } = req.body;
        const appRes = await db.query('SELECT * FROM applications WHERE id = $1', [req.params.id]);
        const app = appRes.rows[0];
        if (!app) return res.status(404).json({ success: false, message: 'Başvuru bulunamadı.' });

        if (typeof teklif_detayi === 'object' && teklif_detayi !== null) {
            teklif_detayi.orjinal_periyot = app.odeme_periyodu;
            teklif_detayi.teklif_periyodu = odeme_periyodu;
        }

        // SLA Update (to close current timer for history)
        const durum = 'teklif_bekleniyor';
        if (app.durum !== durum) {
            const activeHistoryRes = await db.query('SELECT id, baslangic_tarihi FROM status_history WHERE application_id = $1 AND bitis_tarihi IS NULL ORDER BY id DESC LIMIT 1', [app.id]);
            const activeHistory = activeHistoryRes.rows[0];
            if (activeHistory) {
                const baslangic = new Date(activeHistory.baslangic_tarihi);
                const simdi = new Date();
                const gecenDakika = Math.round((simdi - baslangic) / 60000);
                await db.query('UPDATE status_history SET bitis_tarihi = CURRENT_TIMESTAMP, gecen_sure_dk = $1 WHERE id = $2', [gecenDakika, activeHistory.id]);
            }
            await db.query('INSERT INTO status_history (application_id, durum) VALUES ($1, $2)', [app.id, durum]);
        }

        await db.query(`
            UPDATE applications 
            SET durum = $1, durum_aciklama = $2, teklif_durumu = 'bekliyor', teklif_detayi = $3, odeme_periyodu = $4, guncelleme_tarihi = CURRENT_TIMESTAMP 
            WHERE id = $5
        `, [durum, aciklama || null, JSON.stringify(teklif_detayi), odeme_periyodu, app.id]);

        await db.query(`INSERT INTO admin_logs (admin_id, islem_tipi, basvuru_id, detay) VALUES ($1, $2, $3, $4)`,
            [req.admin.id, 'Fiyat Teklifi', app.id, `Ödeme periyodu: ${odeme_periyodu} olarak teklif iletildi. ${aciklama ? 'Not: ' + aciklama : ''}`]);

        // Email Data
        const emailData = {
            basvuru_no: app.basvuru_no,
            yetkili_ad_soyad: app.yetkili_ad_soyad,
            odeme_periyodu: odeme_periyodu,
            teklif_detayi: teklif_detayi,
            aciklama: aciklama,
            teklif_linki: `${process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000'}/pos/teklif.html?token=${app.token}`
        };

        sendEmail(app.email, 'teklifIletildi', emailData);
        sendSMS(app.telefon, smsTemplates.durumGuncellendi(app.basvuru_no, DURUM_LABELS[durum]));

        res.json({ success: true, message: 'Fiyat teklifi müşteriye iletildi.' });
    } catch (err) {
        console.error("Teklif iletme hatası:", err);
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
        await db.query(`INSERT INTO admin_logs (admin_id, islem_tipi, basvuru_id, detay) VALUES ($1, $2, $3, $4)`,
            [req.admin.id, 'Eksik Evrak İsteği', app.id, `Eksik belgeler: ${eksik_belgeler.map(b => BELGE_TIPLERI[b] || b).join(', ')}. ${aciklama ? 'Not: ' + aciklama : ''}`]);

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
        let query = `SELECT * FROM applications WHERE 1=1`;
        const params = [];
        let paramCount = 1;

        if (req.query.durum) { query += ` AND durum = $${paramCount++}`; params.push(req.query.durum); }
        if (req.query.il) { query += ` AND il = $${paramCount++}`; params.push(req.query.il); }
        if (req.query.basvuru_no) { query += ` AND basvuru_no ILIKE $${paramCount++}`; params.push(`%${req.query.basvuru_no}%`); }
        if (req.query.firma) { query += ` AND firma_unvani ILIKE $${paramCount++}`; params.push(`%${req.query.firma}%`); }
        if (req.query.tarih_baslangic) { query += ` AND (basvuru_tarihi AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Istanbul')::date >= $${paramCount++}::date`; params.push(req.query.tarih_baslangic); }
        if (req.query.tarih_bitis) { query += ` AND (basvuru_tarihi AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Istanbul')::date <= $${paramCount++}::date`; params.push(req.query.tarih_bitis); }

        query += ' ORDER BY basvuru_tarihi DESC';

        const basvurularRes = await db.query(query, params);
        const basvurular = basvurularRes.rows;

        // Fetch SLA history for detailed stage durations
        const appIds = basvurular.map(b => b.id);
        const historyDict = {};
        if (appIds.length > 0) {
            const historyRes = await db.query('SELECT application_id, durum, gecen_sure_dk, baslangic_tarihi, bitis_tarihi FROM status_history WHERE application_id = ANY($1)', [appIds]);
            historyRes.rows.forEach(h => {
                if (!historyDict[h.application_id]) historyDict[h.application_id] = {};
                if (!historyDict[h.application_id][h.durum]) historyDict[h.application_id][h.durum] = 0;
                let addMinutes = h.gecen_sure_dk || 0;
                if (!h.bitis_tarihi) { // Devam eden aktif aşama süresi
                   addMinutes += Math.round((new Date() - new Date(h.baslangic_tarihi)) / 60000);
                }
                historyDict[h.application_id][h.durum] += addMinutes;
            });
        }

        const durumLabels = {
            alindi: 'Başvuru Alındı',
            inceleme: 'Evrak İnceleme',
            degerlendirme: 'Değerlendirme',
            teklif_bekleniyor: 'Teklif Bekleniyor',
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
            
            const h = historyDict[b.id] || {};
            const formatSaat = (dk) => dk ? (Math.round(dk / 60.0 * 10) / 10) + ' Saat' : '-';
            const formatSla = (hours) => {
                if (hours == null) return '-';
                let totalMinutes = Math.round(hours * 60);
                if (totalMinutes < 0) totalMinutes = 0;
                if (totalMinutes < 60) return `${totalMinutes}`;
                let mins = totalMinutes % 60;
                let totalHours = Math.floor(totalMinutes / 60);
                let days = Math.floor(totalHours / 24);
                let remHours = totalHours % 24;
                if (days > 0) {
                    return `${days}:${remHours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
                } else {
                    return `${totalHours}:${mins.toString().padStart(2, '0')}`;
                }
            };
            const guncelSLA = b.sla_toplam_saat || Math.round((new Date() - new Date(b.basvuru_tarihi)) / 3600000 * 10) / 10;
            const mevcutDurumSaat = (b.durum === 'onaylandi' || b.durum === 'reddedildi') ? 0 : Math.round((new Date() - new Date(b.guncelleme_tarihi || b.basvuru_tarihi)) / 3600000 * 10) / 10;

            let teklifStr = '-';
            if (b.teklif_detayi) {
                try {
                    let td = typeof b.teklif_detayi === 'string' ? JSON.parse(b.teklif_detayi) : b.teklif_detayi;
                    let oranlar = [];
                    if(td.tek_cekim) oranlar.push(`Tek Çekim: %${td.tek_cekim}`);
                    for(let i=2; i<=12; i++) {
                        if(td['taksit_'+i]) oranlar.push(`${i} Taksit: %${td['taksit_'+i]}`);
                    }
                    teklifStr = `Talep: ${td.orjinal_periyot || b.odeme_periyodu || '-'} | Teklif: ${td.teklif_periyodu || b.odeme_periyodu || '-'} | Oranlar: ${oranlar.join(', ')}`;
                } catch(e) {
                    teklifStr = 'Hata';
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
                'Başvurulan Ürünler': b.pos_tipi || '-',
                'İnternet Site URL': b.website_url || '-',
                'POS Adedi': b.pos_adedi,
                'Cihaz Detayları': cihazlarStr,
                'Tahmini Ciro': b.aylik_ciro,
                'Durum': durumLabels[b.durum] || b.durum,
                'Tarih': b.basvuru_tarihi,
                'SLA (Toplam)': formatSla(guncelSLA),
                'Mevcut Durum SLA': formatSla(mevcutDurumSaat),
                'Fiyat Teklifi ve Oranlar': teklifStr,
                'Bekleme: Alındı': formatSaat(h['alindi']),
                'Bekleme: Evrak Bekleme': formatSaat(h['ek_bilgi']),
                'Bekleme: İnceleme': formatSaat(h['inceleme']),
                'Bekleme: Değerlendirme': formatSaat(h['degerlendirme']),
                'Onaylanma Tarihi': b.onaylanma_tarihi || '-'
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
        const bugunRes = await db.query("SELECT COUNT(*) as count FROM applications WHERE (basvuru_tarihi AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Istanbul')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Istanbul')::date");
        const illerRes = await db.query("SELECT DISTINCT il FROM applications WHERE il IS NOT NULL ORDER BY il");
        const slaGecenRes = await db.query(`SELECT COUNT(*) as count FROM applications WHERE COALESCE(sla_toplam_saat, ROUND((EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - basvuru_tarihi)) / 3600.0)::numeric, 1)) > 24 AND durum NOT IN ('onaylandi', 'reddedildi')`);

        res.json({
            success: true,
            toplam: parseInt(toplamRes.rows[0].count),
            bugun: parseInt(bugunRes.rows[0].count),
            slaGecen: parseInt(slaGecenRes.rows[0].count),
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
        const usersRes = await db.query('SELECT id, email, ad_soyad, aktif, olusturma_tarihi, son_giris_tarihi FROM admin_users ORDER BY id');
        res.json({ success: true, data: usersRes.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Sunucu hatası' });
    }
});

// POST /api/admin/user - Yeni yönetici ekle
router.post('/user', authMiddleware, async (req, res) => {
    const { email, ad_soyad } = req.body;
    if (!email || !ad_soyad) {
        return res.status(400).json({ success: false, message: 'Ad Soyad ve Email alanları zorunludur.' });
    }

    try {
        // Geçici şifre ataması ve token oluşturma
        const dummyHash = '*'; // Şifre oluşturulana kadar login olamaması için geçersiz bir hash
        const crypto = require('crypto');
        const resetToken = crypto.randomBytes(32).toString('hex');
        
        await db.query(`
            INSERT INTO admin_users (email, password_hash, ad_soyad, reset_token, reset_token_expires) 
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP + INTERVAL '24 hours')
        `, [email, dummyHash, ad_soyad, resetToken]);
        
        // Şifre belirleme mailini gönder
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const emailData = {
            ad_soyad: ad_soyad,
            reset_link: `${baseUrl}/admin/set-password.html?token=${resetToken}`
        };
        sendEmail(email, 'adminSetPassword', emailData);
        
        res.json({ success: true, message: 'Kullanıcı oluşturuldu ve şifre belirleme linki e-posta ile gönderildi.' });
    } catch (err) {
        if (err.message && err.message.includes('unique constraint')) {
            return res.status(400).json({ success: false, message: 'Bu email adresi zaten kullanımda.' });
        }
        res.status(500).json({ success: false, message: 'Kullanıcı eklenirken hata oluştu.' });
    }
});

// POST /api/admin/set-password - E-posta ile gelen token üzerinden şifre belirle
router.post('/set-password', async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) {
        return res.status(400).json({ success: false, message: 'Token ve yeni şifre gerekli.' });
    }

    if (password.length < 6) {
        return res.status(400).json({ success: false, message: 'Şifre en az 6 karakter olmalıdır.' });
    }

    try {
        const userRes = await db.query('SELECT id FROM admin_users WHERE reset_token = $1 AND reset_token_expires > CURRENT_TIMESTAMP AND aktif = 1', [token]);
        const user = userRes.rows[0];
        if (!user) {
            return res.status(400).json({ success: false, message: 'Geçersiz veya süresi dolmuş link.' });
        }

        const hash = bcrypt.hashSync(password, 10);
        await db.query('UPDATE admin_users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2', [hash, user.id]);
        res.json({ success: true, message: 'Şifreniz başarıyla belirlendi. Artık giriş yapabilirsiniz.' });
    } catch (err) {
        console.error('Şifre belirleme hatası:', err);
        res.status(500).json({ success: false, message: 'Sunucu hatası.' });
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

// DELETE /api/admin/basvuru/:id - Başvuruyu kalıcı olarak sil
router.delete('/basvuru/:id', authMiddleware, async (req, res) => {
    try {
        const appRes = await db.query('SELECT * FROM applications WHERE id = $1', [req.params.id]);
        if (appRes.rows.length === 0) return res.status(404).json({ success: false, message: 'Başvuru bulunamadı.' });

        // İlgili kayıtları sil (Foreign key cascade yoksa manuel silmek gerekebilir ama biz baştan yapalım)
        await db.query('DELETE FROM documents WHERE application_id = $1', [req.params.id]);
        await db.query('DELETE FROM application_notes WHERE application_id = $1', [req.params.id]);
        await db.query('DELETE FROM notifications WHERE application_id = $1', [req.params.id]);

        // Foreign key hatasını önlemek için geçmiş loglardaki basvuru bağlantısını null yapıyoruz
        await db.query('UPDATE admin_logs SET basvuru_id = NULL WHERE basvuru_id = $1', [req.params.id]);

        await db.query('DELETE FROM applications WHERE id = $1', [req.params.id]);

        await db.query(`INSERT INTO admin_logs (admin_id, islem_tipi, basvuru_id, detay) VALUES ($1, $2, NULL, $3)`,
            [req.admin.id, 'Başvuru Silme', `${appRes.rows[0].basvuru_no} numaralı "${appRes.rows[0].firma_unvani}" firmasına ait başvuru sistemden kalıcı olarak silindi.`]);

        res.json({ success: true, message: 'Başvuru silindi.' });
    } catch (err) {
        console.error('Silme hatası:', err);
        res.status(500).json({ success: false, message: 'Sunucu hatası' });
    }
});

// GET /api/admin/logs - Tüm işlemleri listele
router.get('/logs', authMiddleware, async (req, res) => {
    try {
        const logsRes = await db.query(`
            SELECT l.*, u.ad_soyad as admin_ad, a.basvuru_no 
            FROM admin_logs l 
            LEFT JOIN admin_users u ON l.admin_id = u.id 
            LEFT JOIN applications a ON l.basvuru_id = a.id 
            ORDER BY l.id DESC LIMIT 300
        `);
        res.json({ success: true, data: logsRes.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Sunucu hatası' });
    }
});

// GET /api/admin/db-size - Veritabanı boyutunu getir
router.get('/db-size', authMiddleware, async (req, res) => {
    try {
        // Toplam veritabanı boyutu
        const sizeRes = await db.query('SELECT pg_database_size(current_database()) as bytes');
        // Kullanıcı tablolarının gerçek boyutu
        const tblRes = await db.query(`
            SELECT COALESCE(sum(pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(tablename))), 0)::bigint as tbl_bytes
            FROM pg_tables WHERE schemaname = 'public'
        `);
        const dbBytes = parseInt(sizeRes.rows[0].bytes);
        const tblBytes = parseInt(tblRes.rows[0].tbl_bytes);
        // Neon free tier limit: 512 MiB
        const limitBytes = 536870912;
        const limitMB = 512;
        const percent = ((dbBytes / limitBytes) * 100).toFixed(2);
        // KB hassasiyetinde göster
        const dbKB = (dbBytes / 1024).toFixed(1);
        const dbMB = (dbBytes / (1024 * 1024)).toFixed(2);
        const tblKB = (tblBytes / 1024).toFixed(1);
        const tblMB = (tblBytes / (1024 * 1024)).toFixed(2);
        const sizeStr = dbBytes >= 1048576 ? `${dbMB} MB` : `${dbKB} KB`;
        const tblStr = tblBytes >= 1048576 ? `${tblMB} MB` : `${tblKB} KB`;
        
        // Cloudinary kullanım bilgisi
        let cloudInfo = null;
        const cldName = process.env.CLOUDINARY_CLOUD_NAME;
        const cldKey = process.env.CLOUDINARY_API_KEY;
        const cldSecret = process.env.CLOUDINARY_API_SECRET;
        if (cldName && cldKey && cldSecret) {
            try {
                const axios = require('axios');
                const cldRes = await axios.get(`https://api.cloudinary.com/v1_1/${cldName}/usage`, {
                    auth: { username: cldKey, password: cldSecret },
                    timeout: 5000
                });
                const u = cldRes.data;
                const usedBytes = u.storage?.usage || 0;
                let limitCldBytes = u.storage?.limit || 0;
                // Cloudinary limit döndürmezse veya 0 ise 25GB varsayımı (Free Tier)
                if (!limitCldBytes || limitCldBytes === 0) {
                    limitCldBytes = 25 * 1024 * 1024 * 1024; 
                }
                const usedMB = (usedBytes / (1024 * 1024)).toFixed(2);
                const limitCldMB = (limitCldBytes / (1024 * 1024)).toFixed(0);
                const cldPercent = limitCldBytes > 0 ? ((usedBytes / limitCldBytes) * 100).toFixed(2) : '0';
                cloudInfo = {
                    used: `${usedMB} MB`,
                    limit: `${limitCldMB} MB`,
                    percent: cldPercent,
                    credits_used: u.credits?.usage ? u.credits.usage.toFixed(1) : '0',
                    credits_limit: u.credits?.limit || 0
                };
            } catch (cldErr) {
                console.error('Cloudinary usage hatası:', cldErr.message);
            }
        }

        res.json({ 
            success: true, 
            size: sizeStr, 
            dataSize: tblStr,
            bytes: dbBytes, 
            dataBytes: tblBytes,
            limitMB: limitMB, 
            percent: percent,
            cloudinary: cloudInfo
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Sunucu hatası' });
    }
});

// --- Paket Yönetimi ---

// GET /api/admin/paketler
router.get('/paketler', authMiddleware, async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM packages ORDER BY id ASC');
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Sunucu hatası' });
    }
});

// POST /api/admin/paket
router.post('/paket', authMiddleware, async (req, res) => {
    try {
        const { paket_adi, odeme_periyodu, tek_cekim, taksit_2, taksit_3, taksit_4, taksit_5, taksit_6, taksit_7, taksit_8, taksit_9, taksit_10, taksit_11, taksit_12 } = req.body;
        await db.query(`
            INSERT INTO packages (paket_adi, odeme_periyodu, tek_cekim, taksit_2, taksit_3, taksit_4, taksit_5, taksit_6, taksit_7, taksit_8, taksit_9, taksit_10, taksit_11, taksit_12) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        `, [paket_adi, odeme_periyodu, tek_cekim||null, taksit_2||null, taksit_3||null, taksit_4||null, taksit_5||null, taksit_6||null, taksit_7||null, taksit_8||null, taksit_9||null, taksit_10||null, taksit_11||null, taksit_12||null]);
        res.json({ success: true, message: 'Paket eklendi.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Sunucu hatası' });
    }
});

// PUT /api/admin/paket/:id
router.put('/paket/:id', authMiddleware, async (req, res) => {
    try {
        const { paket_adi, odeme_periyodu, tek_cekim, taksit_2, taksit_3, taksit_4, taksit_5, taksit_6, taksit_7, taksit_8, taksit_9, taksit_10, taksit_11, taksit_12 } = req.body;
        await db.query(`
            UPDATE packages 
            SET paket_adi=$1, odeme_periyodu=$2, tek_cekim=$3, taksit_2=$4, taksit_3=$5, taksit_4=$6, taksit_5=$7, taksit_6=$8, taksit_7=$9, taksit_8=$10, taksit_9=$11, taksit_10=$12, taksit_11=$13, taksit_12=$14, guncelleme_tarihi=CURRENT_TIMESTAMP
            WHERE id=$15
        `, [paket_adi, odeme_periyodu, tek_cekim||null, taksit_2||null, taksit_3||null, taksit_4||null, taksit_5||null, taksit_6||null, taksit_7||null, taksit_8||null, taksit_9||null, taksit_10||null, taksit_11||null, taksit_12||null, req.params.id]);
        res.json({ success: true, message: 'Paket güncellendi.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Sunucu hatası' });
    }
});

// DELETE /api/admin/paket/:id
router.delete('/paket/:id', authMiddleware, async (req, res) => {
    try {
        await db.query('DELETE FROM packages WHERE id=$1', [req.params.id]);
        res.json({ success: true, message: 'Paket silindi.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Sunucu hatası' });
    }
});

module.exports = router;
