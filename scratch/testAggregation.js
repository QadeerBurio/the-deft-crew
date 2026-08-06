require('dotenv').config();
const mongoose = require('mongoose');
const eventAggregator = require('../services/events/eventAggregator');
const connectDB = require('../config/db');

async function testEngine() {
  console.log('🧪 Testing Automatic Event Aggregation System Engine...');
  
  try {
    await connectDB();
    console.log('✅ DB Connected');

    const result = await eventAggregator.runAggregation();
    console.log('🎉 Aggregation Result:', JSON.stringify(result, null, 2));

    const { Event } = require('../models/Event');
    const totalEvents = await Event.countDocuments({});
    console.log(`📊 Total events in DB: ${totalEvents}`);

    process.exit(0);
  } catch (err) {
    console.error('❌ Aggregation test failed:', err);
    process.exit(1);
  }
}

testEngine();
