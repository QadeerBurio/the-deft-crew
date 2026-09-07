require('dotenv').config();
const mongoose = require('mongoose');
const eventCleanup = require('./services/events/eventCleanup');
const { Event } = require('./models/Event');

async function runExpiryTest() {
  console.log('🚀 Connecting to MongoDB for Expiry Test...');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected to MongoDB.');

  // Clean up any existing test records first
  await Event.deleteMany({ source: 'test_expiry' });

  const now = Date.now();
  const yesterday = new Date(now - 2 * 86400000); // 2 days ago
  const nextYear = new Date(now + 365 * 86400000); // Next year

  console.log('\n📝 Inserting 3 test events...');

  const pastEvent = await new Event({
    title: 'TEST_EXPIRY_PAST_EVENT',
    date: 'Yesterday Event',
    parsedDate: yesterday,
    location: 'Test Venue Past',
    source: 'test_expiry',
    sourceId: `test_past_${Date.now()}`,
    isExpired: false
  }).save();

  const futureEvent = await new Event({
    title: 'TEST_EXPIRY_FUTURE_EVENT',
    date: 'Future Event',
    parsedDate: nextYear,
    location: 'Test Venue Future',
    source: 'test_expiry',
    sourceId: `test_future_${Date.now()}`,
    isExpired: false
  }).save();

  const nullDateEvent = await new Event({
    title: 'TEST_EXPIRY_NULL_DATE_EVENT',
    date: 'TBA Event',
    parsedDate: null,
    location: 'Test Venue Null',
    source: 'test_expiry',
    sourceId: `test_null_${Date.now()}`,
    isExpired: false
  }).save();

  console.log('✅ 3 Test events inserted successfully.\n');

  console.log('⏰ Running eventCleanup.expirePastEvents()...');
  const expiredCount = await eventCleanup.expirePastEvents();
  console.log(`   Expired pass total count flagged: ${expiredCount}\n`);

  // Fetch updated status from DB
  const updatedPast = await Event.findById(pastEvent._id);
  const updatedFuture = await Event.findById(futureEvent._id);
  const updatedNull = await Event.findById(nullDateEvent._id);

  console.log('🔍 Expiry Verification Results:');
  console.log(`1. Past Event (${updatedPast.title}):`);
  console.log(`   - parsedDate: ${updatedPast.parsedDate ? updatedPast.parsedDate.toISOString() : null}`);
  console.log(`   - isExpired: ${updatedPast.isExpired} (Expected: true)`);
  console.log(`   - status: "${updatedPast.status}" (Expected: "expired")`);

  console.log(`\n2. Future Event (${updatedFuture.title}):`);
  console.log(`   - parsedDate: ${updatedFuture.parsedDate ? updatedFuture.parsedDate.toISOString() : null}`);
  console.log(`   - isExpired: ${updatedFuture.isExpired} (Expected: false)`);
  console.log(`   - status: "${updatedFuture.status}"`);

  console.log(`\n3. Null ParsedDate Event (${updatedNull.title}):`);
  console.log(`   - parsedDate: ${updatedNull.parsedDate}`);
  console.log(`   - isExpired: ${updatedNull.isExpired} (Expected: false)`);
  console.log(`   - status: "${updatedNull.status}"`);

  const isSuccess =
    updatedPast.isExpired === true &&
    updatedFuture.isExpired === false &&
    updatedNull.isExpired === false;

  if (isSuccess) {
    console.log('\n🎉 TEST PASSED: Past event correctly expired, future and null parsedDate events skipped!');
  } else {
    console.warn('\n⚠️ TEST FAILED: Unexpected expiry state.');
  }

  // Cleanup test events
  console.log('\n🧹 Cleaning up test events from database...');
  await Event.deleteMany({ source: 'test_expiry' });
  console.log('✅ Cleaned up all test events.');

  await mongoose.disconnect();
  console.log('👋 Disconnected from MongoDB.');
}

runExpiryTest().catch(err => {
  console.error('❌ Expiry test error:', err);
  mongoose.disconnect();
});
