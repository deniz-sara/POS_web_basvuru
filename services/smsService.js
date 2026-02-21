const twilio = require('twilio');

// Environment Ayarları (Render'da .env olarak ayarlanacak)
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhone = process.env.TWILIO_PHONE_NUMBER;
const BASE_URL = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';

let twilioClient = null;
if (accountSid && authToken && twilioPhone) {
    twilioClient = twilio(accountSid, authToken);
}

async function sendSMS(telefon, mesaj) {
    // Telefon numarasını uluslararası formata (+90...) çevir
    let temizTelefon = telefon.replace(/\D/g, '');
    if (temizTelefon.startsWith('0')) {
        temizTelefon = temizTelefon.substring(1);
    }
    if (!temizTelefon.startsWith('90')) {
        temizTelefon = '90' + temizTelefon;
    }
    temizTelefon = '+' + temizTelefon;

    // Eğer Twilio API Key'leri eksikse sistemi çökertmeden Demo Modunda logla
    if (!twilioClient) {
        console.log(`📱 [SMS DEMO - TWILIO EKSİK] → ${temizTelefon}: ${mesaj}`);
        return { success: true, demo: true };
    }

    try {
        const message = await twilioClient.messages.create({
            body: mesaj,
            from: twilioPhone,
            to: temizTelefon
        });

        console.log(`✅ SMS başarıyla gönderildi: ${temizTelefon}, ID: ${message.sid}`);
        return { success: true, result: message.sid };
    } catch (err) {
        console.error(`❌ SMS gönderim hatası: ${err.message}`);
        return { success: false, error: err.message };
    }
}

const smsTemplates = {
    basvuruAlindi: (basvuruNo, token) =>
        `POS basvurunuz alinmistir. Basvuru No: ${basvuruNo}. Sitemizden durumunuzu takip edebilirsiniz.`,

    eksikEvrak: (basvuruNo, token) =>
        `POS basvurunuzda (${basvuruNo}) eksik evrak tespit edildi. Lutfen QNBpay uzerinden belgelerinizi guncelleyin.`,

    durumGuncellendi: (basvuruNo, durum) =>
        `POS basvurunuz (${basvuruNo}) guncellendi. Yeni durum: ${durum}. Detay icin uygulamaya giriniz.`
};

module.exports = { sendSMS, smsTemplates };
