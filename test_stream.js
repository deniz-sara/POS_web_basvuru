require('dotenv').config();
const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

async function run() {
    const buffer = Buffer.from('hello world debug pdf text fake file');
    try {
        const result = await new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream({
                folder: 'pos_test',
                resource_type: 'raw',
                public_id: 'test_buffer.txt'
            }, (error, res) => {
                if (error) reject(error);
                else resolve(res);
            });
            Readable.from(buffer).pipe(uploadStream);
        });
        console.log("Success:", result.secure_url);
    } catch (e) {
        console.error("Error:", e);
    }
}
run();
