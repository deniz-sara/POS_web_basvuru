require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.set('trust proxy', 1);
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/pos', express.static('public'));
app.use(express.static('public')); // Also keep root to not break other things if any

// Uploads klasörünü statik sun (admin belgeler için)
app.use('/uploads', express.static('uploads'));

// Ensure uploads folder exists
const uploadDir = path.join(__dirname, 'uploads/pos');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Routes
const basvuruRoutes = require('./routes/basvuru');
const adminRoutes = require('./routes/admin');
const belgeRoutes = require('./routes/belge');

app.use('/api/pos', basvuruRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/pos', belgeRoutes);

// Healthcheck
app.get('/ping', (req, res) => res.json({ message: 'POS Server is alive', cors: 'working' }));

// Global Error Handler
app.use((err, req, res, next) => {
    console.error('Global Error:', err);
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, message: 'Dosya boyutu çok büyük (max 15MB).' });
    }
    res.status(err.status || 500).json({ success: false, message: err.message || 'Internal Server Error' });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`\n🚀 POS Başvuru Sunucusu çalışıyor: http://0.0.0.0:${port}`);
    console.log(`📋 POS Formu: http://0.0.0.0:${port}/pos/basvuru.html`);
    console.log(`🔐 Admin Paneli: http://0.0.0.0:${port}/pos/admin/login.html\n`);
});

module.exports = app;
