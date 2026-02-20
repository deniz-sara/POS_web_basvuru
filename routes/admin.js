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
router.post('/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email ve şifre gerekli.' });

    const user = db.prepare('SELECT * FROM admin_users WHERE email = ? AND aktif = 1').get(email);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return res.status(401).json({ success: false, message: 'Email veya şifre hatalı.' });
    }

    const token = generateToken({ id: user.id, email: user.email, ad_soyad: user.ad_soyad });
    res.json({ success: true, token, admin: { id: user.id, email: user.email, ad_soyad: user.ad_soyad } });
});

// GET /api/admin/basvurular - Tüm başvurular (filtreleme destekli)
router.get('/basvurular', authMiddleware, (req, res) => {
    let query = `
    SELECT a.*,
      COUNT(d.id) as toplam_belge,
      SUM(CASE WHEN d.durum = 'eksik' THEN 1 ELSE 0 END) as eksik_belge
    FROM applications a
    LEFT JOIN documents d ON a.id = d.application_id
    WHERE 1=1
  `;
    const params = [];

    if (req.query.durum) { query += ' AND a.durum = ?'; params.push(req.query.durum); }
    if (req.query.il) { query += ' AND a.il = ?'; params.push(req.query.il); }
    if (req.query.basvuru_no) { query += ' AND a.basvuru_no LIKE ?'; params.push(`%${req.query.basvuru_no}%`); }
    if (req.query.firma) { query += ' AND a.firma_unvani LIKE ?'; params.push(`%${req.query.firma}%`); }
    if (req.query.tarih_baslangic) { query += ' AND a.basvuru_tarihi >= ?'; params.push(req.query.tarih_baslangic); }
    if (req.query.tarih_bitis) { query += ' AND a.basvuru_tarihi <= ?'; params.push(req.query.tarih_bitis + ' 23:59:59'); }

    query += ' GROUP BY a.id ORDER BY a.basvuru_tarihi DESC';

    if (req.query.limit) { query += ' LIMIT ?'; params.push(parseInt(req.query.limit)); }

    const basvurular = db.prepare(query).all(...params);
    res.json({ success: true, data: basvurular, toplam: basvurular.length });
});

// GET /api/admin/basvuru/:id - Tekil başvuru detay
router.get('/basvuru/:id', authMiddleware, (req, res) => {
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
    if (!app) return res.status(404).json({ success: false, message: 'Başvuru bulunamadı.' });

    const docs = db.prepare('SELECT * FROM documents WHERE application_id = ?').all(app.id);
    const notes = db.prepare('SELECT n.*, u.ad_soyad FROM application_notes n LEFT JOIN admin_users u ON n.admin_id = u.id WHERE n.application_id = ? ORDER BY n.olusturma_tarihi DESC').all(app.id);

    res.json({ success: true, basvuru: app, belgeler: docs, notlar: notes });
});

// PUT /api/admin/basvuru/:id/durum - Durum güncelle
router.put('/basvuru/:id/durum', authMiddleware, (req, res) => {
    const { durum, aciklama } = req.body;
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
    if (!app) return res.status(404).json({ success: false, message: 'Başvuru bulunamadı.' });

    db.prepare(`UPDATE applications SET durum = ?, durum_aciklama = ?, guncelleme_tarihi = CURRENT_TIMESTAMP WHERE id = ?`).run(durum, aciklama || null, app.id);

    // Bildirim gönder
    const emailData = { basvuru_no: app.basvuru_no, token: app.token, yetkili_ad_soyad: app.yetkili_ad_soyad, yeni_durum_label: DURUM_LABELS[durum] || durum, aciklama };
    sendEmail(app.email, 'durumGuncellendi', emailData);
    sendSMS(app.telefon, smsTemplates.durumGuncellendi(app.basvuru_no, DURUM_LABELS[durum] || durum));

    db.prepare(`INSERT INTO notifications (application_id, tip, alici, konu, icerik) VALUES (?, ?, ?, ?, ?)`).run(app.id, 'email', app.email, 'Durum Güncellendi', durum);

    res.json({ success: true, message: 'Durum güncellendi.' });
});

// PUT /api/admin/basvuru/:id/eksik-evrak - Eksik evrak işaretle + bildirim
router.put('/basvuru/:id/eksik-evrak', authMiddleware, (req, res) => {
    const { eksik_belgeler, aciklama } = req.body;
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
    if (!app) return res.status(404).json({ success: false, message: 'Başvuru bulunamadı.' });

    // Belgeleri eksik olarak işaretle
    eksik_belgeler.forEach(belge_tipi => {
        const existing = db.prepare('SELECT id FROM documents WHERE application_id = ? AND belge_tipi = ?').get(app.id, belge_tipi);
        if (existing) {
            db.prepare('UPDATE documents SET durum = ? WHERE id = ?').run('eksik', existing.id);
        } else {
            // Belge hiç yüklenmemiş - kayıt oluştur
            db.prepare('INSERT INTO documents (application_id, belge_tipi, belge_adi, dosya_yolu, durum) VALUES (?, ?, ?, ?, ?)').run(app.id, belge_tipi, BELGE_TIPLERI[belge_tipi] || belge_tipi, '', 'eksik');
        }
    });

    // Durum güncelle
    db.prepare('UPDATE applications SET durum = ?, durum_aciklama = ?, guncelleme_tarihi = CURRENT_TIMESTAMP WHERE id = ?').run('ek_bilgi', aciklama || null, app.id);

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

    db.prepare(`INSERT INTO notifications (application_id, tip, alici, konu, icerik) VALUES (?, ?, ?, ?, ?)`).run(app.id, 'email', app.email, 'Eksik Evrak', eksik_belgeler.join(', '));

    res.json({ success: true, message: 'Eksik evrak bildirimi gönderildi.', upload_token: uploadToken });
});

// POST /api/admin/basvuru/:id/not - Not ekle
router.post('/basvuru/:id/not', authMiddleware, (req, res) => {
    const { not_metni } = req.body;
    db.prepare('INSERT INTO application_notes (application_id, admin_id, not_metni) VALUES (?, ?, ?)').run(req.params.id, req.admin.id, not_metni);
    res.json({ success: true, message: 'Not eklendi.' });
});

const xlsx = require('xlsx');

// GET /api/admin/export - XLSX export
router.get('/export', authMiddleware, (req, res) => {
    const basvurular = db.prepare('SELECT * FROM applications ORDER BY basvuru_tarihi DESC').all();

    const formattedData = basvurular.map(b => ({
        'Başvuru No': b.basvuru_no,
        'Firma Unvanı': b.firma_unvani,
        'Vergi No': b.vergi_no,
        'Yetkili': b.yetkili_ad_soyad,
        'Telefon': b.telefon,
        'Email': b.email,
        'İl': b.il,
        'POS Adedi': b.pos_adedi,
        'Durum': b.durum,
        'Tarih': b.basvuru_tarihi
    }));

    const worksheet = xlsx.utils.json_to_sheet(formattedData);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, "Başvurular");

    const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="pos-basvurular-${Date.now()}.xlsx"`);
    res.send(buffer);
});

// GET /api/admin/stats - İstatistikler
router.get('/stats', authMiddleware, (req, res) => {
    const toplam = db.prepare('SELECT COUNT(*) as count FROM applications').get().count;
    const durumlar = db.prepare('SELECT durum, COUNT(*) as count FROM applications GROUP BY durum').all();
    const bugun = db.prepare("SELECT COUNT(*) as count FROM applications WHERE date(basvuru_tarihi) = date('now')").get().count;

    res.json({ success: true, toplam, bugun, durumlar });
});

// GET /api/admin/users - Tüm yöneticiler
router.get('/users', authMiddleware, (req, res) => {
    const users = db.prepare('SELECT id, email, ad_soyad, aktif, olusturma_tarihi FROM admin_users').all();
    res.json({ success: true, data: users });
});

// POST /api/admin/user - Yeni yönetici ekle
router.post('/user', authMiddleware, (req, res) => {
    const { email, password, ad_soyad } = req.body;
    if (!email || !password || !ad_soyad) {
        return res.status(400).json({ success: false, message: 'Tüm alanlar zorunludur.' });
    }

    try {
        const hash = bcrypt.hashSync(password, 10);
        db.prepare('INSERT INTO admin_users (email, password_hash, ad_soyad) VALUES (?, ?, ?)').run(email, hash, ad_soyad);
        res.json({ success: true, message: 'Kullanıcı başarıyla oluşturuldu.' });
    } catch (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ success: false, message: 'Bu email adresi zaten kullanımda.' });
        }
        res.status(500).json({ success: false, message: 'Kullanıcı eklenirken hata oluştu.' });
    }
});

// Dosyalara erişim endpoint'i (admin)
router.get('/dosya/:filename', authMiddleware, (req, res) => {
    const filePath = path.join(__dirname, '../uploads/pos', req.params.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, message: 'Dosya bulunamadı.' });
    res.sendFile(filePath);
});

module.exports = router;
