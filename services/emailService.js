const axios = require('axios');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'basvuru-ekibi@sirketiniz.com';
const BREVO_API_KEY = process.env.BREVO_API_KEY ? process.env.BREVO_API_KEY.replace(/['"]/g, '').trim() : '';
const SENDER_EMAIL = process.env.SMTP_USER || 'noreply@pos.com'; // Brevo'da onaylı Gmail adresiniz
const SENDER_NAME = 'POS Başvuru Sistemi';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// Email şablonları
const templates = {
  basvuruAlindiMusteri: (data) => ({
    subject: `POS Başvurunuz Alındı - Başvuru No: ${data.basvuru_no}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8f9fa;padding:20px;border-radius:10px">
        <div style="background:linear-gradient(135deg,#1a237e,#283593);padding:25px;border-radius:8px 8px 0 0;text-align:center">
          <h1 style="color:#fff;margin:0;font-size:22px">🏦 POS Başvurusu Alındı</h1>
        </div>
        <div style="background:#fff;padding:30px;border-radius:0 0 8px 8px">
          <p style="color:#333;font-size:16px">Sayın <strong>${data.yetkili_ad_soyad}</strong>,</p>
          <p style="color:#555">POS başvurunuz başarıyla alınmıştır. Başvurunuz en kısa sürede değerlendirilecektir.</p>
          <div style="background:#e8eaf6;padding:20px;border-radius:8px;margin:20px 0;border-left:4px solid #1a237e">
            <p style="margin:5px 0;color:#333"><strong>📋 Başvuru No:</strong> ${data.basvuru_no}</p>
            <p style="margin:5px 0;color:#333"><strong>🏢 Firma:</strong> ${data.firma_unvani}</p>
            <p style="margin:5px 0;color:#333"><strong>📅 Tarih:</strong> ${new Date().toLocaleDateString('tr-TR')}</p>
            <p style="margin:5px 0;color:#333"><strong>📱 POS Adedi:</strong> ${data.pos_adedi} adet (${data.pos_tipi})</p>
          </div>
          <div style="text-align:center;margin:25px 0">
            <a href="${BASE_URL}/pos/durum?token=${data.token}" style="background:linear-gradient(135deg,#1a237e,#283593);color:#fff;padding:12px 30px;border-radius:25px;text-decoration:none;font-weight:bold;font-size:15px">
              📊 Başvuru Durumunu Takip Et
            </a>
          </div>
          <p style="color:#888;font-size:13px;text-align:center">Bu email otomatik olarak gönderilmiştir. Sorularınız için bizimle iletişime geçebilirsiniz.</p>
        </div>
      </div>
    `
  }),

  basvuruAlindiAdmin: (data) => ({
    subject: `[YENİ BAŞVURU] ${data.firma_unvani} - ${data.basvuru_no}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#1a237e;padding:20px;text-align:center">
          <h2 style="color:#fff;margin:0">Yeni POS Başvurusu</h2>
        </div>
        <div style="padding:20px;background:#fff">
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666">Başvuru No</td><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold">${data.basvuru_no}</td></tr>
            <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666">Firma</td><td style="padding:8px;border-bottom:1px solid #eee">${data.firma_unvani}</td></tr>
            <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666">Yetkili</td><td style="padding:8px;border-bottom:1px solid #eee">${data.yetkili_ad_soyad}</td></tr>
            <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666">Telefon</td><td style="padding:8px;border-bottom:1px solid #eee">${data.telefon}</td></tr>
            <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666">Email</td><td style="padding:8px;border-bottom:1px solid #eee">${data.email}</td></tr>
            <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666">POS Talebi</td><td style="padding:8px;border-bottom:1px solid #eee">${data.pos_adedi} adet ${data.pos_tipi}</td></tr>
            <tr><td style="padding:8px;color:#666">İl</td><td style="padding:8px">${data.il} / ${data.ilce}</td></tr>
          </table>
          <div style="text-align:center;margin-top:20px">
            <a href="${BASE_URL}/pos/admin/panel.html" style="background:#1a237e;color:#fff;padding:10px 25px;border-radius:5px;text-decoration:none">Admin Panele Git</a>
          </div>
        </div>
      </div>
    `
  }),

  eksikEvrak: (data) => ({
    subject: `[EVRAK EKSİK] POS Başvurunuz - ${data.basvuru_no}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8f9fa;padding:20px;border-radius:10px">
        <div style="background:linear-gradient(135deg,#e65100,#bf360c);padding:25px;border-radius:8px 8px 0 0;text-align:center">
          <h1 style="color:#fff;margin:0;font-size:22px">⚠️ Eksik Evrak Bildirimi</h1>
        </div>
        <div style="background:#fff;padding:30px;border-radius:0 0 8px 8px">
          <p style="color:#333;font-size:16px">Sayın <strong>${data.yetkili_ad_soyad}</strong>,</p>
          <p style="color:#555"><strong>${data.basvuru_no}</strong> numaralı POS başvurunuzda aşağıdaki evraklar eksik tespit edilmiştir:</p>
          <div style="background:#fff3e0;padding:15px;border-radius:8px;margin:15px 0;border-left:4px solid #e65100">
            <ul style="margin:0;padding-left:20px;color:#333">
              ${data.eksik_belgeler.map(b => `<li style="margin:5px 0"><strong>${b}</strong></li>`).join('')}
            </ul>
          </div>
          ${data.aciklama ? `<p style="color:#555;background:#f5f5f5;padding:12px;border-radius:6px"><strong>Not:</strong> ${data.aciklama}</p>` : ''}
          <div style="text-align:center;margin:25px 0">
            <a href="${BASE_URL}/pos/belge-guncelle?token=${data.upload_token}" style="background:linear-gradient(135deg,#e65100,#bf360c);color:#fff;padding:12px 30px;border-radius:25px;text-decoration:none;font-weight:bold;font-size:15px">
              📎 Eksik Evrakları Yükle
            </a>
          </div>
          <p style="color:#888;font-size:12px;text-align:center">Bu link 48 saat geçerlidir.</p>
        </div>
      </div>
    `
  }),

  durumGuncellendi: (data) => ({
    subject: `POS Başvurunuz Güncellendi - ${data.basvuru_no}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8f9fa;padding:20px;border-radius:10px">
        <div style="background:linear-gradient(135deg,#1b5e20,#2e7d32);padding:25px;border-radius:8px 8px 0 0;text-align:center">
          <h1 style="color:#fff;margin:0;font-size:22px">📋 Başvuru Durumu Güncellendi</h1>
        </div>
        <div style="background:#fff;padding:30px;border-radius:0 0 8px 8px">
          <p style="color:#333">Sayın <strong>${data.yetkili_ad_soyad}</strong>,</p>
          <p style="color:#555"><strong>${data.basvuru_no}</strong> numaralı başvurunuzun durumu güncellendi.</p>
          <div style="background:#e8f5e9;padding:15px;border-radius:8px;margin:15px 0;text-align:center">
            <p style="margin:0;font-size:20px;font-weight:bold;color:#1b5e20">${data.yeni_durum_label}</p>
          </div>
          ${data.aciklama ? `<p style="color:#555">${data.aciklama}</p>` : ''}
          <div style="text-align:center;margin:25px 0">
            <a href="${BASE_URL}/pos/durum?token=${data.token}" style="background:#1b5e20;color:#fff;padding:12px 30px;border-radius:25px;text-decoration:none;font-weight:bold">
              Durumu Görüntüle
            </a>
          </div>
        </div>
      </div>
    `
  }),

  belgeYuklendi: (data) => ({
    subject: `[EVRAK GÜNCELLENDİ] ${data.firma_unvani} - ${data.basvuru_no}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#1b5e20;padding:20px;text-align:center">
          <h2 style="color:#fff;margin:0">✅ Evrak Güncellendi</h2>
        </div>
        <div style="padding:20px;background:#fff">
          <p><strong>${data.firma_unvani}</strong> firması (<strong>${data.basvuru_no}</strong>) aşağıdaki evrakları yükledi:</p>
          <ul>
            ${data.yuklenen_belgeler.map(b => `<li><strong>${b}</strong></li>`).join('')}
          </ul>
          <div style="text-align:center;margin-top:20px">
            <a href="${BASE_URL}/pos/admin/panel.html" style="background:#1b5e20;color:#fff;padding:10px 25px;border-radius:5px;text-decoration:none">Admin Panele Git</a>
          </div>
        </div>
      </div>
    `
  })
};

async function sendEmail(to, templateName, data) {
  console.log(`[EMAIL] '${templateName}' şablonu ile ${to} adresine gönderim başlıyor...`);

  if (!BREVO_API_KEY) {
    console.error(`❌ Email GÖNDERİLEMEDİ: BREVO_API_KEY tanımlanmamış! Lütfen Render ayarlarına ekleyin.`);
    return { success: false, error: 'API Key eksik' };
  }

  try {
    const template = templates[templateName](data);
    const maskedKey = BREVO_API_KEY.substring(0, 14) + '...';
    console.log(`[EMAIL] Şablon hazırlandı. Brevo API isteği atılıyor... (Anahtar: ${maskedKey})`);

    const payload = {
      sender: { name: SENDER_NAME, email: SENDER_EMAIL },
      to: [{ email: to }],
      subject: template.subject,
      htmlContent: template.html
    };

    const response = await axios.post('https://api.brevo.com/v3/smtp/email', payload, {
      headers: {
        'Accept': 'application/json',
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    console.log(`✅ Email başarıyla gönderildi: ${templateName} → ${to} | Brevo ID: ${response.data.messageId}`);
    return { success: true };
  } catch (err) {
    const errorMsg = err.response && err.response.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`❌ Email GÖNDERİLEMEDİ (${templateName} -> ${to}):`, errorMsg);
    return { success: false, error: errorMsg };
  }
}

module.exports = { sendEmail, ADMIN_EMAIL };
