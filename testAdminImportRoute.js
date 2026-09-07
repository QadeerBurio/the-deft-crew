require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const User = require('./models/User');
const { Event } = require('./models/Event');
const eventRoutes = require('./routes/event.routes');

async function runEndpointTests() {
  console.log('🚀 Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected to MongoDB.');

  // Find or create an admin user
  let adminUser = await User.findOne({ role: 'admin' });
  if (!adminUser) {
    adminUser = await new User({
      name: 'Test Admin',
      email: `admin_${Date.now()}@test.com`,
      password: 'hashedpassword',
      role: 'admin'
    }).save();
  }

  // Find or create a student user
  let studentUser = await User.findOne({ role: 'student' });
  if (!studentUser) {
    studentUser = await new User({
      name: 'Test Student',
      email: `student_${Date.now()}@test.com`,
      password: 'hashedpassword',
      role: 'student'
    }).save();
  }

  const adminToken = jwt.sign({ id: adminUser._id }, process.env.JWT_SECRET);
  const studentToken = jwt.sign({ id: studentUser._id }, process.env.JWT_SECRET);

  // Setup local Express server for testing
  const app = express();
  app.use(express.json());
  app.use('/api/events', eventRoutes);

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}/api/events/admin/import-csv`;

  console.log(`📡 Test server running on port ${port}\n`);

  const axios = require('axios');
  const FormData = require('form-data');

  // Scenario A: Admin token + Valid XLSX file
  console.log('▶️ Scenario A: Valid Admin Token + Real XLSX File');
  try {
    const form = new FormData();
    const xlsxPath = path.join(__dirname, 'Ticketwala_Karachi_Events.xlsx');
    form.append('file', fs.createReadStream(xlsxPath));

    const res = await axios.post(baseUrl, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${adminToken}`
      }
    });

    console.log(`   Response Status: ${res.status}`);
    console.log(`   Response Body:`, JSON.stringify(res.data));
    if (res.status === 200 && res.data.success === true) {
      console.log('   ✅ Scenario A Passed!');
    }
  } catch (err) {
    console.error('   ❌ Scenario A Failed:', err.response ? err.response.data : err.message);
  }

  // Scenario B: Non-Admin Token
  console.log('\n▶️ Scenario B: Non-Admin (Student) Token');
  try {
    const form = new FormData();
    const xlsxPath = path.join(__dirname, 'Ticketwala_Karachi_Events.xlsx');
    form.append('file', fs.createReadStream(xlsxPath));

    await axios.post(baseUrl, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${studentToken}`
      }
    });
    console.error('   ❌ Scenario B Failed: Should have returned 403');
  } catch (err) {
    console.log(`   Response Status: ${err.response ? err.response.status : 'N/A'}`);
    console.log(`   Response Body:`, JSON.stringify(err.response ? err.response.data : {}));
    if (err.response && err.response.status === 403) {
      console.log('   ✅ Scenario B Passed! Correctly rejected with 403 Forbidden.');
    }
  }

  // Scenario C: Invalid File Type (.txt file)
  console.log('\n▶️ Scenario C: Invalid File Type (.txt file)');
  const dummyTxtPath = path.join(__dirname, 'invalid_test.txt');
  fs.writeFileSync(dummyTxtPath, 'This is a text file, not a CSV or XLSX');

  try {
    const form = new FormData();
    form.append('file', fs.createReadStream(dummyTxtPath));

    await axios.post(baseUrl, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${adminToken}`
      }
    });
    console.error('   ❌ Scenario C Failed: Should have returned 400');
  } catch (err) {
    console.log(`   Response Status: ${err.response ? err.response.status : 'N/A'}`);
    console.log(`   Response Body:`, JSON.stringify(err.response ? err.response.data : {}));
    if (err.response && err.response.status === 400) {
      console.log('   ✅ Scenario C Passed! Correctly rejected with 400 Bad Request.');
    }
  } finally {
    if (fs.existsSync(dummyTxtPath)) {
      fs.unlinkSync(dummyTxtPath);
    }
  }

  server.close();
  await mongoose.disconnect();
  console.log('\n👋 Disconnected from MongoDB. Server closed.');
}

runEndpointTests().catch(err => {
  console.error('❌ Endpoint test failed with error:', err);
  mongoose.disconnect();
});
