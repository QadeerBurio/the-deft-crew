// test_cloudinary.js
const { cloudinary } = require('./config/cloudinary');

cloudinary.uploader.upload('test-logo.jpeg', (error, result) => {
  if (error) console.error('❌ Error:', error);
  else console.log('✅ Success:', result.secure_url);
});