const cloudinary = require('cloudinary').v2;
require('dotenv').config();

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

async function run() {
    const buffer = Buffer.from('PDF_DUMMY_CONTENT_12345');
    const base64Str = buffer.toString('base64');
    const dataUri = `data:application/pdf;base64,${base64Str}`;

    try {
        const result = await cloudinary.uploader.upload(dataUri, {
            folder: 'pos_test',
            resource_type: 'raw',
            public_id: 'test_datauri.pdf'
        });
        console.log("Success:", result.secure_url);
    } catch (e) {
        console.error("Cloudinary Error:", e);
    }
}
run();
