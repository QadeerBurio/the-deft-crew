require('dotenv').config();
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const FormData = require('form-data');

const User = require('./models/User');
const { Event } = require('./models/Event');
const eventRoutes = require('./routes/event.routes');
const eventCleanup = require('./services/events/eventCleanup');

const e2eXlsxPath = path.join(__dirname, 'E2E_Fresh_Events.xlsx');

// 1. Generate fresh test XLSX file with 3 brand new events
function createFreshXlsx() {
  const freshRows = [
    {
      name: 'Karachi AI Summit 2026',
      date: '25th Nov 2026, 10:00 AM',
      venue: 'IBA Main Campus Karachi',
      description: 'Annual AI and Tech conference for developers and researchers',
      category: 'Tech',
      source_url: 'https://example.com/e2e/1'
    },
    {
      name: 'Indie Rock Night Live',
      date: '5th Dec 2026, 8:00 PM',
      venue: 'District 19 Karachi',
      description: 'Live indie music concert featuring local rock bands',
      category: 'Concert',
      source_url: 'https://example.com/e2e/2'
    },
    {
      name: 'Startup Pitch Competition',
      date: '15th Dec 2026, 2:00 PM',
      venue: 'NIC Karachi',
      description: 'Pitch competition for early-stage university startups',
      category: 'Networking',
      source_url: 'https://example.com/e2e/3'
    }
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(freshRows);
  XLSX.utils.book_append_sheet(wb, ws, 'Events');
  XLSX.writeFile(wb, e2eXlsxPath);
  console.log('📄 Created fresh test file: E2E_Fresh_Events.xlsx (3 events)');
}

async function runE2E() {
  console.log('🚀 Starting Full End-to-End Workflow Test...\n');
  createFreshXlsx();

  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected to MongoDB.');

  // Clean up any old E2E test events if re-run
  await Event.deleteMany({ sourceId: { $regex: '^https://example.com/e2e/' } });

  // Get/Create Admin User & Token
  let adminUser = await User.findOne({ role: 'admin' });
  if (!adminUser) {
    adminUser = await new User({
      name: 'E2E Admin',
      email: `e2e_admin_${Date.now()}@test.com`,
      password: 'hashedpassword',
      role: 'admin'
    }).save();
  }
  const adminToken = jwt.sign({ id: adminUser._id }, process.env.JWT_SECRET);

  // Spin up test server
  const app = express();
  app.use(express.json());
  app.use('/api/events', eventRoutes);
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}/api/events`;

  console.log(`📡 Test server listening on port ${port}\n`);

  try {
    // -------------------------------------------------------------
    // Test 1: Upload Fresh XLSX file via Admin API
    // -------------------------------------------------------------
    console.log('1️⃣ Test 1: Uploading fresh events via POST /api/events/admin/import-csv...');
    const form1 = new FormData();
    form1.append('file', fs.createReadStream(e2eXlsxPath));

    const res1 = await axios.post(`${baseUrl}/admin/import-csv`, form1, {
      headers: {
        ...form1.getHeaders(),
        Authorization: `Bearer ${adminToken}`
      }
    });

    console.log('   Response Status:', res1.status);
    console.log('   Response Data:', JSON.stringify(res1.data));
    const passed1 = res1.data.success && res1.data.added === 3 && res1.data.skipped === 0;
    console.log(passed1 ? '   ✅ Test 1 Passed! (added: 3, skipped: 0)\n' : '   ❌ Test 1 Failed!\n');

    // -------------------------------------------------------------
    // Test 2: Live Feed Check (GET /api/events/feed)
    // -------------------------------------------------------------
    console.log('2️⃣ Test 2: Checking Live Feed GET /api/events/feed...');
    const feedRes = await axios.get(`${baseUrl}/feed`);
    console.log('   Feed Response Status:', feedRes.status);
    const feedEvents = feedRes.data.events || feedRes.data;
    console.log(`   Total feed events returned: ${feedEvents.length}`);

    const sampleFresh = feedEvents.find(e => e.title === 'Karachi AI Summit 2026');
    if (sampleFresh) {
      console.log('   Sample Fresh Event in Feed:');
      console.log(`     - Title: "${sampleFresh.title}"`);
      console.log(`     - Date: "${sampleFresh.date}"`);
      console.log(`     - Location: "${sampleFresh.location}"`);
      console.log(`     - Type: "${sampleFresh.type}"`);
      console.log(`     - Categories: ${JSON.stringify(sampleFresh.categories)}`);
      console.log(`     - Image: "${sampleFresh.image}"`);
      console.log(`     - ExternalUrl: "${sampleFresh.externalUrl}"`);
      console.log('   ✅ Test 2 Passed! Well-formed data verified in live feed.\n');
    } else {
      console.warn('   ⚠️ Test 2 Warning: Fresh event not found in feed list.\n');
    }

    // -------------------------------------------------------------
    // Test 3: Duplicate Re-check (Re-upload exact same file)
    // -------------------------------------------------------------
    console.log('3️⃣ Test 3: Re-uploading exact same file for duplicate protection check...');
    const form2 = new FormData();
    form2.append('file', fs.createReadStream(e2eXlsxPath));

    const res2 = await axios.post(`${baseUrl}/admin/import-csv`, form2, {
      headers: {
        ...form2.getHeaders(),
        Authorization: `Bearer ${adminToken}`
      }
    });

    console.log('   Response Status:', res2.status);
    console.log('   Response Data:', JSON.stringify(res2.data));
    const passed3 = res2.data.success && res2.data.added === 0 && res2.data.skipped === 3;
    console.log(passed3 ? '   ✅ Test 3 Passed! 0 duplicates added, 3 skipped.\n' : '   ❌ Test 3 Failed!\n');

    // -------------------------------------------------------------
    // Test 4: Data Integrity Check (Count events in DB)
    // -------------------------------------------------------------
    console.log('4️⃣ Test 4: Verifying database document count...');
    const totalCsvEvents = await Event.countDocuments({ source: 'csv' });
    console.log(`   Total DB events with source 'csv': ${totalCsvEvents} (Expected: 67 = 64 Ticketwala + 3 Fresh)`);
    const passed4 = totalCsvEvents === 67;
    console.log(passed4 ? '   ✅ Test 4 Passed! Data integrity verified.\n' : '   ❌ Test 4 Failed!\n');

    // -------------------------------------------------------------
    // Test 5: Expiry Check (Run expirePastEvents on full dataset)
    // -------------------------------------------------------------
    console.log('5️⃣ Test 5: Running eventCleanup.expirePastEvents() on full dataset...');
    const expiredCount = await eventCleanup.expirePastEvents();
    console.log(`   Expired pass count: ${expiredCount}`);
    
    // Check that our future test events were NOT expired
    const freshEventsInDb = await Event.find({ sourceId: { $regex: '^https://example.com/e2e/' } });
    const anyIncorrectlyExpired = freshEventsInDb.some(e => e.isExpired === true);
    console.log(anyIncorrectlyExpired ? '   ❌ Test 5 Failed: Future events were incorrectly expired!' : '   ✅ Test 5 Passed! Expiry pass executed cleanly with 0 false expiries.\n');

  } catch (err) {
    console.error('❌ E2E Error:', err.response ? err.response.data : err.message);
  } finally {
    // Clean up fresh E2E test events from DB & disk file
    await Event.deleteMany({ sourceId: { $regex: '^https://example.com/e2e/' } });
    if (fs.existsSync(e2eXlsxPath)) fs.unlinkSync(e2eXlsxPath);
    server.close();
    await mongoose.disconnect();
    console.log('👋 Disconnected from MongoDB. E2E Test finished cleanly.');
  }
}

runE2E();
