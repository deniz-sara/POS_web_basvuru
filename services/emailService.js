const axios = require('axios');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'basvuru-ekibi@sirketiniz.com';
const BREVO_API_KEY = process.env.BREVO_API_KEY ? process.env.BREVO_API_KEY.replace(/['"]/g, '').trim() : '';
const SENDER_EMAIL = process.env.SMTP_USER || 'noreply@pos.com'; // Brevo'da onaylı Gmail adresiniz
const SENDER_NAME = 'POS Başvuru Sistemi';
const BASE_URL = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';

// Email şablonları
const QNB_LOGO = `${BASE_URL}/qnb-mail-logo.png`;
const QNB_COLOR = "#001b59";

const headerHtml = (title) => `
  <div style="background:#ffffff;padding:25px;border-radius:8px 8px 0 0;text-align:center;border-bottom:3px solid ${QNB_COLOR}">
    <img src="${QNB_LOGO}" alt="QNBpay" style="height:45px;margin-bottom:15px;display:block;margin-left:auto;margin-right:auto">
    <h1 style="color:${QNB_COLOR};margin:0;font-size:22px">${title}</h1>
  </div>
`;

// Email şablonları
const templates = {
  basvuruAlindiMusteri: (data) => ({
    subject: `Başvurunuz Alındı - Başvuru No: ${data.basvuru_no}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8f9fa;padding:20px;border-radius:10px;border:1px solid #ddd">
        ${headerHtml('Başvurunuz Alındı')}
        <div style="background:#fff;padding:30px;border-radius:0 0 8px 8px">
          <p style="color:#333;font-size:16px">Sayın <strong>${data.yetkili_ad_soyad}</strong>,</p>
          <p style="color:#555">QNBpay <strong>${data.pos_tipi}</strong> başvurunuz başarıyla alınmıştır. İlgili birimlerimiz en kısa sürede değerlendirmeyi tamamlayacaktır.</p>
          <div style="background:#f4f6f9;padding:20px;border-radius:8px;margin:20px 0;border-left:4px solid ${QNB_COLOR}">
            <p style="margin:5px 0;color:#333"><strong>📋 Başvuru No:</strong> ${data.basvuru_no}</p>
            <p style="margin:5px 0;color:#333"><strong>🏢 Firma:</strong> ${data.firma_unvani}</p>
            <p style="margin:5px 0;color:#333"><strong>📅 Tarih:</strong> ${new Date().toLocaleDateString('tr-TR')}</p>
            <p style="margin:5px 0;color:#333"><strong>📱 Başvurulan Ürünler:</strong> ${data.pos_tipi}</p>
          </div>
          <div style="text-align:center;margin:30px 0">
            <a href="${BASE_URL}/pos/durum.html?token=${data.token}" style="background:${QNB_COLOR};color:#fff;padding:14px 30px;border-radius:25px;text-decoration:none;font-weight:bold;font-size:15px;display:inline-block">
              Başvuru Durumunu Takip Et
            </a>
          </div>
          <p style="color:#888;font-size:13px;text-align:center">Bu email bilgilendirme amacıyla otomatik olarak gönderilmiştir.</p>
        </div>
      </div>
    `
  }),

  basvuruAlindiAdmin: (data) => ({
    subject: `[YENİ BAŞVURU] ${data.firma_unvani} - ${data.basvuru_no}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8f9fa;padding:20px;border-radius:10px;border:1px solid #ddd">
        ${headerHtml('Yeni Başvuru')}
        <div style="padding:30px;background:#fff;border-radius:0 0 8px 8px">
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#666">Başvuru No</td><td style="padding:10px;border-bottom:1px solid #eee;font-weight:bold">${data.basvuru_no}</td></tr>
            <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#666">Firma</td><td style="padding:10px;border-bottom:1px solid #eee">${data.firma_unvani}</td></tr>
            <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#666">Yetkili</td><td style="padding:10px;border-bottom:1px solid #eee">${data.yetkili_ad_soyad}</td></tr>
            <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#666">Telefon</td><td style="padding:10px;border-bottom:1px solid #eee">${data.telefon}</td></tr>
            <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#666">Email</td><td style="padding:10px;border-bottom:1px solid #eee">${data.email}</td></tr>
            <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#666">Talep Edilen Ürünler</td><td style="padding:10px;border-bottom:1px solid #eee">${data.pos_tipi}</td></tr>
            <tr><td style="padding:10px;color:#666">İl/İlçe</td><td style="padding:10px">${data.il} / ${data.ilce}</td></tr>
          </table>
          <div style="text-align:center;margin-top:25px">
            <a href="${BASE_URL}/pos/admin/login.html" style="background:${QNB_COLOR};color:#fff;padding:12px 25px;border-radius:5px;text-decoration:none;font-weight:bold;display:inline-block">Admin Panele Git</a>
          </div>
        </div>
      </div>
    `
  }),

  eksikEvrak: (data) => ({
    subject: `[EVRAK EKSİK] Başvurunuz - ${data.basvuru_no}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8f9fa;padding:20px;border-radius:10px;border:1px solid #ddd">
        ${headerHtml('Eksik Evrak Bildirimi')}
        <div style="background:#fff;padding:30px;border-radius:0 0 8px 8px">
          <p style="color:#333;font-size:16px">Sayın <strong>${data.yetkili_ad_soyad}</strong>,</p>
          <p style="color:#555"><strong>${data.basvuru_no}</strong> numaralı başvurunuzda aşağıdaki evraklar eksik/hatalı tespit edilmiştir:</p>
          <div style="background:#fff3e0;padding:15px;border-radius:8px;margin:15px 0;border-left:4px solid #e65100">
            <ul style="margin:0;padding-left:20px;color:#333">
              ${data.eksik_belgeler.map(b => `<li style="margin:5px 0"><strong>${b}</strong></li>`).join('')}
            </ul>
          </div>
          ${data.aciklama ? `<p style="color:#555;background:#f5f5f5;padding:12px;border-radius:6px"><strong>Yönetici Notu:</strong> ${data.aciklama}</p>` : ''}
          <div style="text-align:center;margin:30px 0">
            <a href="${BASE_URL}/pos/belge-guncelle.html?token=${data.upload_token}" style="background:#e65100;color:#fff;padding:14px 30px;border-radius:25px;text-decoration:none;font-weight:bold;font-size:15px;display:inline-block">
              Eksik Evrakları Yükle
            </a>
          </div>
        </div>
      </div>
    `
  }),

  durumGuncellendi: (data) => ({
    subject: `Başvurunuz Güncellendi - ${data.basvuru_no}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8f9fa;padding:20px;border-radius:10px;border:1px solid #ddd">
        ${headerHtml('Başvuru Durumu Güncellendi')}
        <div style="background:#fff;padding:30px;border-radius:0 0 8px 8px">
          <p style="color:#333">Sayın <strong>${data.yetkili_ad_soyad}</strong>,</p>
          <p style="color:#555"><strong>${data.basvuru_no}</strong> numaralı başvurunuzun durumu güncellendi.</p>
          <div style="background:#e8f5e9;padding:15px;border-radius:8px;margin:20px 0;text-align:center;border:1px solid #c8e6c9">
            <p style="margin:0;font-size:20px;font-weight:bold;color:#1b5e20">${data.yeni_durum_label}</p>
          </div>
          ${data.aciklama ? `<p style="color:#555">Açıklama: ${data.aciklama}</p>` : ''}
          <div style="text-align:center;margin:30px 0">
            <a href="${BASE_URL}/pos/durum.html?token=${data.token}" style="background:${QNB_COLOR};color:#fff;padding:14px 30px;border-radius:25px;text-decoration:none;font-weight:bold;display:inline-block">
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
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8f9fa;padding:20px;border-radius:10px;border:1px solid #ddd">
        ${headerHtml('Evrak Güncellendi')}
        <div style="padding:30px;background:#fff;border-radius:0 0 8px 8px">
          <p><strong>${data.firma_unvani}</strong> firması (<strong>${data.basvuru_no}</strong>) eksik evraklarını sisteme yükledi:</p>
          <ul>
            ${data.yuklenen_belgeler.map(b => `<li><strong>${b}</strong></li>`).join('')}
          </ul>
          <div style="text-align:center;margin-top:25px">
            <a href="${BASE_URL}/pos/admin/login.html" style="background:${QNB_COLOR};color:#fff;padding:12px 25px;border-radius:5px;text-decoration:none;font-weight:bold;display:inline-block">Admin Panele Git</a>
          </div>
        </div>
      </div>
    `
  }),

  adminSetPassword: (data) => ({
    subject: `Yönetici Hesabınız Oluşturuldu - Şifre Belirleyin`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8f9fa;padding:20px;border-radius:10px;border:1px solid #ddd">
        ${headerHtml('Hesabınız Oluşturuldu')}
        <div style="padding:30px;background:#fff;border-radius:0 0 8px 8px;text-align:center;">
          <p style="color:#333;font-size:16px;text-align:left;">Sayın <strong>${data.ad_soyad}</strong>,</p>
          <p style="color:#555;text-align:left;">QNBpay Yönetim Paneli'nde sizin için bir yönetici hesabı oluşturulmuştur. Sisteme giriş yapabilmek için lütfen aşağıdaki butona tıklayarak şifrenizi belirleyiniz.</p>
          <div style="margin:30px 0;">
            <a href="${data.reset_link}" style="background:${QNB_COLOR};color:#fff;padding:14px 30px;border-radius:25px;text-decoration:none;font-weight:bold;font-size:15px;display:inline-block">Şifremi Belirle</a>
          </div>
          <p style="color:#888;font-size:12px;">Bu bağlantı 24 saat boyunca geçerlidir. Bağlantıya tıklayamıyorsanız şu adresi kopyalayıp tarayıcınıza yapıştırın:<br><br><span style="word-break:break-all;color:${QNB_COLOR};">${data.reset_link}</span></p>
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
