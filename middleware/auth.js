const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'pos_basvuru_gizli_anahtar_2024';

const authMiddleware = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, message: 'Yetkisiz erişim. Token gerekli.' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.admin = decoded;
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
