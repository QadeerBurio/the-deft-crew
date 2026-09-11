// testCsvJobImporter.js
// ============================================================
// Verification test for services/jobs/csvJobImporter.js
// ============================================================

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const mongoose = require('mongoose');
const Job = require('./models/Job');
const { importJobsFromFile, mapCategory, mapLocationType, mapJobType, extractSkills } = require('./services/jobs/csvJobImporter');

async function runTest() {
  console.log('🚀 Connecting to MongoDB for CSV Job Importer test...');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected to MongoDB.\n');

  // --- UNIT TEST HELPER FUNCTIONS ---
  console.log('🧪 Testing Helper Mapping Functions (Exact copy of importCsvJobs.js logic)...');
  
  const techCat = mapCategory('CS & IT', 'Software Engineer');
  console.assert(techCat === 'Technology', `Expected Technology, got ${techCat}`);

  const mktCat = mapCategory('Marketing Department', 'Brand Manager');
  console.assert(mktCat === 'Marketing', `Expected Marketing, got ${mktCat}`);

  const finCat = mapCategory('Finance Department', 'Tax Associate');
  console.assert(finCat === 'Finance', `Expected Finance, got ${finCat}`);

  console.assert(mapLocationType('Remote Work from Home') === 'Remote', 'mapLocationType Remote failed');
  console.assert(mapLocationType('Karachi Hybrid') === 'Hybrid', 'mapLocationType Hybrid failed');
  console.assert(mapLocationType('Islamabad Office') === 'On-site', 'mapLocationType On-site failed');

  console.assert(mapJobType('Summer Internship') === 'Internship', 'mapJobType Internship failed');
  console.assert(mapJobType('Part-Time Consultant') === 'Part-time', 'mapJobType Part-time failed');
  console.assert(mapJobType('Full-Time Engineer') === 'Full-time', 'mapJobType Full-time failed');

  const skills = extractSkills('React & Node.js Developer', 'CS', 'Students');
  console.assert(skills.includes('React') && skills.includes('Node.js'), 'extractSkills failed');
  console.log('✅ All helper mapping unit tests passed!\n');

  try {
    // --- TEST 1: IMPORT FROM BUFFER (2 NEW JOBS) ---
    console.log('▶️ Test 1: Importing 2 new jobs from CSV Buffer...');
    
    const testCompany1 = `TestComp_${Date.now()}`;
    const testCompany2 = `MktAgency_${Date.now()}`;

    const csvContent = [
      'Company,Job Title / Program,Department,Job Type,Target Audience,Application Link / Method,Location',
      `"${testCompany1}","Senior React Developer","CS & Software","Full-Time","Graduates","https://careers.testcomp.com/job/1","Karachi Remote"`,
      `"${testCompany2}","Brand Marketing Associate","Marketing Department","Summer Internship","Undergraduates","https://agency.com/apply","Lahore On-site"`
    ].join('\n');

    const buffer = Buffer.from(csvContent, 'utf-8');
    const result1 = await importJobsFromFile(buffer, 'test_sample.csv');

    console.log('   Import Result 1:', result1);
    console.assert(result1.created === 2, `Expected 2 created jobs, got ${result1.created}`);
    console.assert(result1.updated === 0, `Expected 0 updated jobs, got ${result1.updated}`);
    console.assert(result1.skipped === 0, `Expected 0 skipped jobs, got ${result1.skipped}`);

    // Verify DB fields for Job 1
    const dbJob1 = await Job.findOne({ companyName: testCompany1, title: 'Senior React Developer' });
    console.assert(dbJob1 !== null, 'Job 1 should exist in DB');
    console.assert(dbJob1.category === 'Technology', `Expected Technology category, got ${dbJob1.category}`);
    console.assert(dbJob1.locationType === 'Remote', `Expected Remote locationType, got ${dbJob1.locationType}`);
    console.assert(dbJob1.type === 'Full-time', `Expected Full-time job type, got ${dbJob1.type}`);
    console.assert(dbJob1.skills.includes('React'), 'Job 1 skills should include React');

    // Verify DB fields for Job 2
    const dbJob2 = await Job.findOne({ companyName: testCompany2, title: 'Brand Marketing Associate' });
    console.assert(dbJob2 !== null, 'Job 2 should exist in DB');
    console.assert(dbJob2.category === 'Marketing', `Expected Marketing category, got ${dbJob2.category}`);
    console.assert(dbJob2.type === 'Internship', `Expected Internship job type, got ${dbJob2.type}`);

    console.log('   ✅ Test 1 Passed! Field mappings & DB records verified.');

    // --- TEST 2: UPSERT / DUPLICATE CHECK ---
    console.log('\n▶️ Test 2: Importing updated CSV (1 existing updated, 1 duplicate in file skipped)...');

    const updatedCsvContent = [
      'Company,Job Title / Program,Department,Job Type,Target Audience,Application Link / Method,Location',
      `"${testCompany1}","Senior React Developer","CS & Software","Full-Time","Graduates","https://careers.testcomp.com/updated","Karachi Remote"`,
      `"${testCompany1}","Senior React Developer","CS & Software","Full-Time","Graduates","https://careers.testcomp.com/updated","Karachi Remote"`
    ].join('\n');

    const buffer2 = Buffer.from(updatedCsvContent, 'utf-8');
    const result2 = await importJobsFromFile(buffer2, 'test_sample_updated.csv');

    console.log('   Import Result 2:', result2);
    console.assert(result2.created === 0, `Expected 0 created jobs, got ${result2.created}`);
    console.assert(result2.updated === 1, `Expected 1 updated job, got ${result2.updated}`);
    console.assert(result2.skipped === 1, `Expected 1 skipped duplicate job in file, got ${result2.skipped}`);

    const updatedJob1 = await Job.findOne({ companyName: testCompany1, title: 'Senior React Developer' });
    console.assert(updatedJob1.externalUrl === 'https://careers.testcomp.com/updated', 'Job 1 externalUrl should be updated');

    console.log('   ✅ Test 2 Passed! Upsert and duplicate detection verified.');

    // Allow setImmediate embedding calls to complete before disconnect
    console.log('\n⚡ Waiting briefly for background embedding calls to settle...');
    await new Promise(r => setTimeout(r, 1000));

    // --- CLEANUP TEST DATA ---
    console.log('🧹 Cleaning up test records from database...');
    await Job.deleteMany({ companyName: { $in: [testCompany1, testCompany2] } });
    console.log('✅ Test cleanup complete.');

  } catch (err) {
    console.error('❌ Test failed with error:', err);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔗 Disconnected from MongoDB. Verification test finished.');
  }
}

runTest();
