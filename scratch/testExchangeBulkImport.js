const express = require('express');
const mongoose = require('mongoose');
const XLSX = require('xlsx');
const axios = require('axios');
const FormData = require('form-data');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const connectDB = require('../config/db');
const Exchange = require('../models/Exchange');
const Scholarships = require('../models/Scholarships');
const User = require('../models/User');
const adminRoutes = require('../routes/admin.routes');

async function runTest() {
  console.log('🧪 Starting Exchange Bulk Import Endpoint Verification Test...\n');
  await connectDB();

  // Setup standalone test express server on port 5001 using latest admin.routes.js
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes);

  const PORT = 5001;
  const server = app.listen(PORT);
  console.log(`📡 In-memory test server listening on http://localhost:${PORT}`);

  // Create an explicit test admin user in DB
  const testAdminEmail = `testadmin_${Date.now()}@example.com`;
  const adminUser = await User.create({
    name: 'Bulk Test Admin',
    email: testAdminEmail,
    password: 'password123',
    role: 'admin',
    status: 'Verified'
  });

  // JWT payload key MUST be 'id' matching auth.middleware.js requirement
  const token = jwt.sign(
    { id: adminUser._id.toString(), role: 'admin' },
    process.env.JWT_SECRET || 'secretkey123',
    { expiresIn: '1h' }
  );

  const timestamp = Date.now();
  // Define test rows for CSV/XLSX generation
  const testRows = [
    {
      'Program Title': `UnitTest Exchange Program ${timestamp}_1`,
      'University': 'University of Oxford',
      'Location': 'Oxford, UK',
      'Degree': 'Masters',
      'Application Start': '2026-06-01',
      'Application Deadline': '2026-09-01',
      'Duration': '2 Years',
      'Application URL': 'https://oxford.ac.uk/apply',
      'Requirements': 'IELTS 7.5, Bachelor Degree, SOP',
      'Scholarship Name': 'Oxford Leadership Award',
      'Scholarship Amount': '10000',
      'Currency': 'GBP',
      'Scholarship Description': 'Fully funded master scholarship',
      'Scholarship Deadline': '2026-08-15',
      'Scholarship Requirements': 'First Class Honors'
    },
    {
      // Missing appStart, deadline, duration -> Should test fallback defaults!
      'Program Title': `UnitTest Exchange Program ${timestamp}_2`,
      'University': 'Harvard University',
      'Location': 'Cambridge, USA',
      'Degree': 'PhD',
      'Application Start': '',
      'Application Deadline': '',
      'Duration': '',
      'Application URL': 'https://harvard.edu/apply',
      'Requirements': 'GRE, Transcripts'
    },
    {
      // Missing title -> Should be SKIPPED
      'Program Title': '',
      'University': 'Invalid University',
      'Location': 'Paris, France',
      'Degree': 'Bachelors'
    },
    {
      // Duplicate of Row 1 -> Should be SKIPPED
      'Program Title': `UnitTest Exchange Program ${timestamp}_1`,
      'University': 'University of Oxford',
      'Location': 'Oxford, UK'
    }
  ];

  // Build XLSX buffer in memory
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(testRows);
  XLSX.utils.book_append_sheet(wb, ws, 'BulkTest');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  // Prepare FormData for HTTP request
  const form = new FormData();
  form.append('file', buffer, {
    filename: 'test_bulk_exchange.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });

  const BULK_URL = `http://localhost:${PORT}/api/admin/exchange/bulk-import`;
  console.log(`📡 Sending POST request to ${BULK_URL}...`);

  try {
    const res = await axios.post(BULK_URL, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${token}`
      }
    });

    console.log('✅ Response Status:', res.status);
    console.log('📊 Response Data:\n', JSON.stringify(res.data, null, 2));

    const { success, created, skipped, totalRows, skippedRows } = res.data;

    // Assertions
    if (!success) throw new Error('Response success flag is false');
    if (created !== 2) throw new Error(`Expected 2 created programs, got ${created}`);
    if (skipped !== 2) throw new Error(`Expected 2 skipped programs, got ${skipped}`);
    if (totalRows !== 4) throw new Error(`Expected totalRows = 4, got ${totalRows}`);

    console.log('\n🔍 Verifying Database records and Fallback Defaults...');

    // Verify Row 1 in DB
    const doc1 = await Exchange.findOne({ title: testRows[0]['Program Title'] }).populate('scholarship');
    if (!doc1) throw new Error('Doc 1 not found in database');
    if (doc1.duration !== '2 Years') throw new Error('Doc 1 duration mismatch');
    if (!doc1.scholarship || doc1.scholarship.name !== 'Oxford Leadership Award') {
      throw new Error('Doc 1 linked scholarship missing or incorrect');
    }
    console.log('  ✅ Row 1 verified with linked Scholarship:', doc1.scholarship.name);

    // Verify Row 2 in DB (checking fallback defaults)
    const doc2 = await Exchange.findOne({ title: testRows[1]['Program Title'] });
    if (!doc2) throw new Error('Doc 2 not found in database');
    const todayStr = new Date().toISOString().split('T')[0];
    if (doc2.appStart !== todayStr) throw new Error(`Doc 2 appStart fallback failed. Expected ${todayStr}, got ${doc2.appStart}`);
    if (doc2.deadline !== 'TBA') throw new Error(`Doc 2 deadline fallback failed. Expected TBA, got ${doc2.deadline}`);
    if (doc2.duration !== '1 Year') throw new Error(`Doc 2 duration fallback failed. Expected 1 Year, got ${doc2.duration}`);
    console.log('  ✅ Row 2 fallback defaults verified successfully!');
    console.log(`     appStart fallback: ${doc2.appStart}`);
    console.log(`     deadline fallback: ${doc2.deadline}`);
    console.log(`     duration fallback: ${doc2.duration}`);

    // Verify skipped rows reports
    console.log('\n🔍 Verifying Skipped Rows Reporting...');
    console.log('  Skipped Row 1 (Missing Title):', JSON.stringify(skippedRows[0]));
    console.log('  Skipped Row 2 (Duplicate):', JSON.stringify(skippedRows[1]));

    // Clean up created test docs and test admin user
    console.log('\n🧹 Cleaning up test database records...');
    if (doc1.scholarship) {
      await Scholarships.findByIdAndDelete(doc1.scholarship._id);
    }
    await Exchange.deleteMany({ _id: { $in: [doc1._id, doc2._id] } });
    await User.findByIdAndDelete(adminUser._id);
    console.log('  ✅ Cleanup complete.');

    server.close();
    console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY!');
  } catch (err) {
    if (adminUser) await User.findByIdAndDelete(adminUser._id);
    server.close();
    console.error('❌ Test Failed:', err.response?.data || err.message);
    process.exit(1);
  }
  process.exit(0);
}

runTest();
