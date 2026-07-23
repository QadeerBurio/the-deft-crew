// test_cloudinary.js
const { cloudinary, hasCloudinary } = require('./config/cloudinary');

// Check if Cloudinary is configured
if (!hasCloudinary) {
  console.error('❌ Cloudinary is not configured. Please check your .env file.');
  process.exit(1);
}

// Test upload
cloudinary.uploader.upload('test-logo.jpeg', (error, result) => {
  if (error) {
    console.error('❌ Error:', error);
    console.error('Error details:', JSON.stringify(error, null, 2));
  } else {
    console.log('✅ Success:', result.secure_url);
    console.log('📦 Public ID:', result.public_id);
  }
});