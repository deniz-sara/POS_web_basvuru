require('dotenv').config({ path: '.env' });
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

if (!process.env.CLOUDINARY_API_KEY) {
    console.error("Missing API KEY. Run with proper env vars.");
    process.exit(1);
}

async function testUpload() {
    const buffer = Buffer.from('PDF_DUMMY_CONTENT_12345_STREAMIFIER');

    try {
        const result = await new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream({
                folder: 'pos_test',
                resource_type: 'raw',
                public_id: 'test_streamifier.pdf'
            }, (error, res) => {
                if (error) return reject(error);
                resolve(res);
            });

            streamifier.createReadStream(buffer).pipe(uploadStream);
        });
        console.log("Upload Success:", result.secure_url);
    } catch (e) {
        console.error("Upload Error:", e);
    }
}
testUpload();
