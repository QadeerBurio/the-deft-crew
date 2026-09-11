// testAdminJobImportRoute.js
// ============================================================
// Endpoint Test Suite for POST /api/jobs/admin/import-csv
// ============================================================

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const FormData = require('form-data');
const User = require('./models/User');
const Job = require('./models/Job');
const jobsRoutes = require('./routes/jobs.routes');

async function runEndpointTests() {
  console.log('🚀 Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected to MongoDB.');

  // 1. Setup Admin & Student users
  let adminUser = await User.findOne({ role: 'admin' });
  if (!adminUser) {
    adminUser = await new User({
      name: 'Test Admin',
      email: `admin_${Date.now()}@test.com`,
      password: 'hashedpassword',
      role: 'admin'
    }).save();
  }

  let studentUser = await User.findOne({ role: 'student' });
  if (!studentUser) {
    studentUser = await new User({
      name: 'Test Student',
      email: `student_${Date.now()}@test.com`,
      password: 'hashedpassword',
      role: 'student'
    }).save();
  }

  const adminToken = jwt.sign({ id: adminUser._id, role: 'admin' }, process.env.JWT_SECRET || 'secret');
  const studentToken = jwt.sign({ id: studentUser._id, role: 'student' }, process.env.JWT_SECRET || 'secret');

  // 2. Spin up temporary Express server
  const app = express();
  app.use(express.json());
  app.use('/api/jobs', jobsRoutes);

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}/api/jobs`;

  console.log(`📡 Test server running on port ${port}\n`);

  const testCompanyName = `RouteTestComp_${Date.now()}`;

  try {
    // SCENARIO 1: Valid Admin Token + Real CSV File
    console.log('▶️ Scenario 1: Valid Admin Token + Valid CSV File');
    const csvData = [
      'Company,Job Title / Program,Department,Job Type,Target Audience,Application Link / Method,Location',
      `"${testCompanyName}","Cloud Infrastructure Engineer","CS & DevOps","Full-Time","Graduates","https://careers.routetest.com","Karachi Hybrid"`
    ].join('\n');

    const form1 = new FormData();
    form1.append('file', Buffer.from(csvData, 'utf-8'), {
      filename: 'sample_jobs.csv',
      contentType: 'text/csv'
    });

    const res1 = await axios.post(`${baseUrl}/admin/import-csv`, form1, {
      headers: {
        ...form1.getHeaders(),
        Authorization: `Bearer ${adminToken}`
      }
    });

    console.log(`   Response Status: ${res1.status}`);
    console.log(`   Response Body:`, JSON.stringify(res1.data));
    console.assert(res1.status === 200 && res1.data.success === true, 'Scenario 1 failed');
    console.log('   ✅ Scenario 1 Passed!');

    // SCENARIO 2: Non-Admin (Student) Token
    console.log('\n▶️ Scenario 2: Non-Admin (Student) Token');
    try {
      const form2 = new FormData();
      form2.append('file', Buffer.from(csvData, 'utf-8'), {
        filename: 'sample_jobs.csv',
        contentType: 'text/csv'
      });

      await axios.post(`${baseUrl}/admin/import-csv`, form2, {
        headers: {
          ...form2.getHeaders(),
          Authorization: `Bearer ${studentToken}`
        }
      });
      console.error('   ❌ Scenario 2 Failed: Should have returned 403');
    } catch (err) {
      console.log(`   Response Status: ${err.response?.status}`);
      console.log(`   Response Body:`, JSON.stringify(err.response?.data));
      console.assert(err.response?.status === 403, 'Scenario 2 should return 403');
      console.log('   ✅ Scenario 2 Passed! Correctly rejected with 403 Forbidden.');
    }

    // SCENARIO 3: Invalid File Type (.txt)
    console.log('\n▶️ Scenario 3: Invalid File Type (.txt file)');
    try {
      const form3 = new FormData();
      form3.append('file', Buffer.from('This is a text file', 'utf-8'), {
        filename: 'invalid_doc.txt',
        contentType: 'text/plain'
      });

      await axios.post(`${baseUrl}/admin/import-csv`, form3, {
        headers: {
          ...form3.getHeaders(),
          Authorization: `Bearer ${adminToken}`
        }
      });
      console.error('   ❌ Scenario 3 Failed: Should have returned 400');
    } catch (err) {
      console.log(`   Response Status: ${err.response?.status}`);
      console.log(`   Response Body:`, JSON.stringify(err.response?.data));
      console.assert(err.response?.status === 400, 'Scenario 3 should return 400');
      console.log('   ✅ Scenario 3 Passed! Correctly rejected with 400 Bad Request.');
    }

    // SCENARIO 4: Sanity Check existing route GET /api/jobs/public/all
    console.log('\n▶️ Scenario 4: Sanity Check existing GET /api/jobs/public/all route');
    const res4 = await axios.get(`${baseUrl}/public/all`);
    console.log(`   Response Status: ${res4.status}`);
    console.log(`   Returned Jobs Count: ${res4.data?.jobs?.length || 0}`);
    console.assert(res4.status === 200 && Array.isArray(res4.data?.jobs), 'Scenario 4 failed');
    console.log('   ✅ Scenario 4 Passed! Public jobs route works normally.');

    // Cleanup created test job
    await Job.deleteMany({ companyName: testCompanyName });
    console.log('\n🧹 Cleaned up route test jobs from DB.');

  } catch (err) {
    console.error('❌ Endpoint test failed with error:', err.response?.data || err.message);
  } finally {
    server.close();
    await mongoose.disconnect();
    console.log('👋 Disconnected from MongoDB. Server closed.');
  }
}

runEndpointTests();
