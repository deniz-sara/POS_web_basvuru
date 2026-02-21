const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

async function run() {
    console.log("Starting Cloudinary test...");
    // A tiny dummy PDF file buffer
    const buffer = Buffer.from("JVBERi0xLjQKJcOkw7zDtsOfCjIgMCBvYmoKPDwvTGVuZ3RoIDMgMCBSL0ZpbHRlci9GbGF0ZURlY29kZT4+CnN0cmVhbQp4nDPQM1Qo5ypUMFAwALJMLY31DGN1FQyN9AwMlXQVQjXMTU0MDY1BDE1jY3OwFBMQYy02s9KzTDFUMDIwAAkAx+gJdgpFTmRzdHJlYW0KZW5kb2JqCgozIDAgb2JqCjMzCmVuZG9iagoKMSAwIG9iago8PC9UeXBlL1BhZ2UvTWVkaWFCb3hbMCAwIDU5NSA4NDJdL1Jlc291cmNlczw8L0ZvbnQ8PC9GMSA0IDAgUj4+Pj4vQ29udGVudHMgMiAwIFIvUGFyZW50IDUgMCBSPj4KZW5kb2JqCgo0IDAgb2JqCjw8L1R5cGUvRm9udC9TdWJ0eXBlL1R5cGUxL0Jhc2VGb250L0hlbHZldGljYT4+CmVuZG9iagoKNSAwIG9iago8PC9UeXBlL1BhZ2VzL0NvdW50IDEvS2lkc1sxIDAgUl0+PgplbmRvYmoKCjYgMCBvYmoKPDwvVHlwZS9DYXRhbG9nL1BhZ2VzIDUgMCBSPj4KZW5kb2JqCgo3IDAgb2JqCjw8L1Byb2R1Y2VyKEdob3N0c2NyaXB0IDkuNTMtcHJlKSk+PgplbmRvYmoKeHJlZgowIDgKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMTE5IDAwMDAwIG4gCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA5OCAwMDAwMCBuIAowMDAwMDAwMjMwIDAwMDAwIG4gCjAwMDAwMDAzMTggMDAwMDAgbiAKMDAwMDAwMDM3NSAwMDAwMCBuIAowMDAwMDAwNDI0IDAwMDAwIG4gCnRyYWlsZXIKPDwvU2l6ZSA4L1Jvb3QgNiAwIFIvSW5mbyA3IDAgUj4+CnN0YXJ0eHJlZgo0ODMvJUVPRgo=", "base64");

    try {
        const result = await new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream({
                folder: 'pos_test',
                resource_type: 'raw',
                public_id: 'dummy_doc.pdf'
            }, (error, res) => {
                if (error) reject(error);
                else resolve(res);
            });
            streamifier.createReadStream(buffer).pipe(uploadStream);
        });
        console.log("Success:", result.secure_url);

        console.log("Now testing resource_type: 'auto'...");
        const result2 = await new Promise((resolve, reject) => {
            const uploadStream2 = cloudinary.uploader.upload_stream({
                folder: 'pos_test',
                resource_type: 'auto',
                public_id: 'dummy_doc2.pdf'
            }, (error, res) => {
                if (error) reject(error);
                else resolve(res);
            });
            streamifier.createReadStream(buffer).pipe(uploadStream2);
        });
        console.log("Success AUTO:", result2.secure_url);

    } catch (e) {
        console.error("Cloudinary Error:", e);
    }
}
run();
