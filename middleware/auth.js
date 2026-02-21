const jwt = require('jsonwebtoken');
const db = require('../database/db');
const JWT_SECRET = process.env.JWT_SECRET || 'pos_basvuru_gizli_anahtar_2024';

const authMiddleware = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    // Dosya indirme (Excel vb.) gibi window.open ile gelen GET istekleri için header yerine query parameresi desteği
    const token = (authHeader && authHeader.split(' ')[1]) || req.query.token;

    if (!token) {
        return res.status(401).json({ success: false, message: 'Yetkisiz erişim. Token gerekli.' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.admin = decoded;

        // Kullanıcının online kalması için son_giriş tarihini asenkron olarak arka planda sürekli güncelle
        if (decoded && decoded.id) {
            db.query('UPDATE admin_users SET son_giris_tarihi = CURRENT_TIMESTAMP WHERE id = $1', [decoded.id]).catch(() => { });
        }

        next();
    } catch (err) {
        return res.status(403).json({ success: false, message: 'Geçersiz veya süresi dolmuş token.' });
    }
};

const generateToken = (payload) => {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });
};

const generateUploadToken = (applicationId, belgeTipleri) => {
    return jwt.sign({ applicationId, belgeTipleri, type: 'upload' }, JWT_SECRET, { expiresIn: '48h' });
};

const verifyUploadToken = (token) => {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch {
        return null;
    }
};

module.exports = { authMiddleware, generateToken, generateUploadToken, verifyUploadToken };
