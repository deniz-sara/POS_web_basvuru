const axios = require('axios');

// Netgsm API Ayarları
const NETGSM_USERCODE = process.env.NETGSM_USERCODE || 'KULLANICI_KODUNUZ';
const NETGSM_PASSWORD = process.env.NETGSM_PASSWORD || 'SIFRENIZ';
const NETGSM_HEADER = process.env.NETGSM_HEADER || 'FIRMAUNVANI'; // Onaylı başlık
const BASE_URL = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';

async function sendSMS(telefon, mesaj) {
    // Telefon numarasını Netgsm formatına çevir (5XXXXXXXXX)
    const temizTelefon = telefon.replace(/\D/g, '').replace(/^0/, '');

    // Demo modu - gerçek API yerine log
    if (!process.env.NETGSM_USERCODE || process.env.NETGSM_USERCODE === 'KULLANICI_KODUNUZ') {
        console.log(`📱 [SMS DEMO] → ${temizTelefon}: ${mesaj}`);
        return { success: true, demo: true };
    }

    try {
        const params = new URLSearchParams({
            usercode: NETGSM_USERCODE,
            password: NETGSM_PASSWORD,
            gsmno: temizTelefon,
            message: mesaj,
            msgheader: NETGSM_HEADER,
            dil: 'TR'
        });

        const response = await axios.get(
            `https://api.netgsm.com.tr/sms/send/get/?${params.toString()}`,
            { timeout: 10000 }
        );

        const result = response.data.toString().trim();
        if (result.startsWith('00')) {
            console.log(`✅ SMS gönderildi: ${temizTelefon}`);
            return { success: true, result };
        } else {
            console.error(`❌ SMS hatası: ${result}`);
            return { success: false, error: `Netgsm hata kodu: ${result}` };
        }
    } catch (err) {
        console.error(`❌ SMS gönderim hatası: ${err.message}`);
        return { success: false, error: err.message };
    }
}

const smsTemplates = {
    basvuruAlindi: (basvuruNo, token) =>
        `POS basvurunuz alindi. Basvuru No: ${basvuruNo}. Takip icin: ${BASE_URL}/pos/durum.html?token=${token}`,

    eksikEvrak: (basvuruNo, token) =>
        `POS basvurunuzda (${basvuruNo}) eksik evrak tespit edildi. Yuklemek icin: ${BASE_URL}/pos/belge-guncelle?token=${token}`,

    durumGuncellendi: (basvuruNo, durum) =>
        `POS basvurunuz (${basvuruNo}) guncellendi. Yeni durum: ${durum}. Detay icin uygulamaya giriniz.`
};

module.exports = { sendSMS, smsTemplates };
