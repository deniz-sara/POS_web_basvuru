require('dotenv').config({ path: '.env' });
const cloudinary = require('cloudinary').v2;
const stream = require('stream');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

if (!process.env.CLOUDINARY_API_KEY) {
    console.error("Missing API KEY. Need to run this from a place with .env");
    process.exit(1);
}

async function testUpload() {
    const buffer = Buffer.from('PDF_DUMMY_CONTENT_12345');

    try {
        const result = await new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream({
                folder: 'pos_test',
                resource_type: 'raw',
                public_id: 'test_stream2.pdf'
            }, (error, res) => {
                if (error) reject(error);
                else resolve(res);
            });

            stream.Readable.from(buffer).pipe(uploadStream);
        });
        console.log("Upload Success:", result.secure_url);
    } catch (e) {
        console.error("Upload Error:", e);
    }
}
testUpload();
