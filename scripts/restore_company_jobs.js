const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const Job = require('../models/Job');

async function restoreCompanyJobs() {
    try {
        const uri = process.env.MONGO_URI || process.env.BACKEND_MONGO_URI;
        await mongoose.connect(uri);
        console.log("🔗 Connected to MongoDB.");

        const jobsToRestore = [
            {
                _id: new mongoose.Types.ObjectId('6a722620a2c6d830a1eace8c'),
                title: 'Full Stack Developer',
                department: 'Technology',
                category: 'Technology',
                location: 'Karachi, Pakistan',
                locationType: 'Hybrid',
                type: 'Full-time',
                salary: '70,000 - 100,000 PKR',
                email: 'careers@deftcrew.com',
                description: 'We are seeking a talented Full Stack Developer to build modern web applications and join our core team.',
                requirements: ['React Native / React.js', 'Node.js & Express', 'MongoDB'],
                responsibilities: ['Develop scalable backend APIs', 'Build responsive mobile and web interfaces'],
                experienceLevel: 'Mid Level',
                minExperience: 2,
                skills: ['JavaScript', 'Node.js', 'React', 'MongoDB'],
                isExternal: false,
                source: 'manual',
                active: true,
                companyName: 'The Deft Crew',
                companyWebsite: 'https://thedeftcrew.com',
                applicationDeadline: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000)
            },
            {
                _id: new mongoose.Types.ObjectId('6a5e7c143a423e378a72e46b'),
                title: 'Junior Software Engineer',
                department: 'Technology',
                category: 'Technology',
                location: 'Karachi, Pakistan',
                locationType: 'On-site',
                type: 'Full-time',
                salary: '50,000 - 75,000 PKR',
                email: 'careers@deftcrew.com',
                description: 'Great opportunity for entry level software engineers to gain real-world experience.',
                requirements: ['JavaScript / Python fundamentals', 'Problem solving skills'],
                experienceLevel: 'Entry Level',
                skills: ['JavaScript', 'Git', 'Problem Solving'],
                isExternal: false,
                source: 'manual',
                active: true,
                companyName: 'The Deft Crew',
                applicationDeadline: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000)
            },
            {
                _id: new mongoose.Types.ObjectId('6a5e9a643a423e378a72e733'),
                title: 'Full Stack Engineer (Node.js/React)',
                department: 'Technology',
                category: 'Technology',
                location: 'Karachi, Pakistan',
                locationType: 'Remote',
                type: 'Full-time',
                salary: '80,000 - 120,000 PKR',
                email: 'careers@deftcrew.com',
                description: 'Looking for a Senior Full Stack Engineer with strong Node.js experience.',
                requirements: ['Node.js', 'React', 'MongoDB', 'System Architecture'],
                experienceLevel: 'Senior Level',
                skills: ['Node.js', 'React', 'System Design'],
                isExternal: false,
                source: 'manual',
                active: true,
                companyName: 'The Deft Crew',
                applicationDeadline: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000)
            },
            {
                _id: new mongoose.Types.ObjectId('6a5e93b43a423e378a72e6a1'),
                title: 'Frontend Developer (React Native)',
                department: 'Technology',
                category: 'Technology',
                location: 'Karachi, Pakistan',
                locationType: 'Hybrid',
                type: 'Full-time',
                salary: '60,000 - 90,000 PKR',
                email: 'careers@deftcrew.com',
                description: 'Join our team as a Frontend Developer working on our flagship mobile app.',
                requirements: ['React Native', 'TypeScript / JavaScript', 'UI/UX design principles'],
                experienceLevel: 'Mid Level',
                skills: ['React Native', 'UI/UX', 'JavaScript'],
                isExternal: false,
                source: 'manual',
                active: true,
                companyName: 'The Deft Crew',
                applicationDeadline: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000)
            }
        ];

        let restoredCount = 0;
        for (const jobDoc of jobsToRestore) {
            const exists = await Job.findById(jobDoc._id);
            if (!exists) {
                const newJob = new Job(jobDoc);
                await newJob.save();
                restoredCount++;
                console.log(`✅ Restored Company Job: "${jobDoc.title}" (ID: ${jobDoc._id})`);
            } else {
                console.log(`ℹ️ Job already exists: "${jobDoc.title}" (ID: ${jobDoc._id})`);
            }
        }

        console.log(`\nTotal Company Jobs Restored: ${restoredCount}`);
        await mongoose.disconnect();
    } catch (err) {
        console.error("❌ Error restoring company jobs:", err);
    }
}

restoreCompanyJobs();
