const express = require("express");
const router = express.Router();
const Job = require("../models/Job");
const JobApplication = require("../models/JobApplication");
const Notification = require("../models/Notification");
const User = require("../models/User");
const { uploadResume, cloudinary } = require("../config/cloudinary");

// Auth middleware
const authMiddleware = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(" ")[1];
        if (!token) return res.status(401).json({ message: "No token provided" });

        const jwt = require("jsonwebtoken");
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.id;
        req.userRole = decoded.role;
        req.user = await User.findById(req.userId);
        next();
    } catch (err) {
        res.status(401).json({ message: "Invalid token" });
    }
};

const isAdminOrEmployee = async (req, res, next) => {
    if (req.user?.role !== "admin" && req.user?.role !== "employee") {
        return res.status(403).json({ message: "Admin or Employee access required" });
    }
    next();
};

// ==================== JOB MANAGEMENT ====================

// Create a new job
router.post("/add", authMiddleware, isAdminOrEmployee, async (req, res) => {
    try {
        const {
            title, department, category, location, locationType, type, salary,
            salaryMin, salaryMax, currency, email, description, requirements,
            responsibilities, benefits, experienceLevel, minExperience,
            education, skills, active, featured, urgent, applicationDeadline,
            companyName, companyWebsite
        } = req.body;

        if (!title || !department || !location || !type || !salary || !email || !description) {
            return res.status(400).json({ error: "Missing required job fields" });
        }

        const newJob = new Job({
            title, department, category, location, locationType, type, salary,
            salaryMin: salaryMin || 0, salaryMax: salaryMax || 0, currency: currency || "USD",
            email, description, requirements: requirements || [],
            responsibilities: responsibilities || [], benefits: benefits || [],
            experienceLevel: experienceLevel || "Mid Level",
            minExperience: minExperience || 0, education: education || "Bachelor's Degree",
            skills: skills || [], active: active !== undefined ? active : true,
            featured: featured || false, urgent: urgent || false,
            applicationDeadline: applicationDeadline || new Date(+new Date() + 30*24*60*60*1000),
            postedBy: req.userId, companyName: companyName || req.user?.name,
            companyWebsite: companyWebsite || ""
        });

        await newJob.save();
        
        const admins = await User.find({ role: "admin" });
        for (const admin of admins) {
            await Notification.create({
                recipient: admin._id,
                title: "New Job Posted! 🎯",
                description: `${req.user.name} posted: ${title}`,
                type: "Job Posting",
                icon: "briefcase",
                metadata: { jobId: newJob._id }
            });
        }
        
        res.status(201).json({ message: "Job posted successfully", data: newJob });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Get all jobs with advanced filters
router.get("/all", authMiddleware, isAdminOrEmployee, async (req, res) => {
    try {
        const { status, department, category, type, locationType, experienceLevel, search, sort } = req.query;
        let query = {};

        if (status === "active") query.active = true;
        if (status === "inactive") query.active = false;
        if (department) query.department = department;
        if (category) query.category = category;
        if (type) query.type = type;
        if (locationType) query.locationType = locationType;
        if (experienceLevel) query.experienceLevel = experienceLevel;
        if (search) {
            query.$or = [
                { title: { $regex: search, $options: 'i' } },
                { department: { $regex: search, $options: 'i' } },
                { description: { $regex: search, $options: 'i' } },
                { companyName: { $regex: search, $options: 'i' } }
            ];
        }

        let sortOption = { createdAt: -1 };
        if (sort === "recent") sortOption = { createdAt: -1 };
        if (sort === "oldest") sortOption = { createdAt: 1 };
        if (sort === "applications") sortOption = { totalApplications: -1 };
        if (sort === "views") sortOption = { views: -1 };

        const jobs = await Job.find(query).sort(sortOption).populate('postedBy', 'name email');
        
        const jobsWithCounts = await Promise.all(jobs.map(async (job) => {
            const appCount = await JobApplication.countDocuments({ jobId: job._id });
            return { ...job.toObject(), totalApplications: appCount };
        }));

        res.json(jobsWithCounts);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get jobs posted by employee
router.get("/my-jobs", authMiddleware, async (req, res) => {
    try {
        const jobs = await Job.find({ postedBy: req.userId }).sort({ createdAt: -1 });
        const jobsWithCounts = await Promise.all(jobs.map(async (job) => {
            const appCount = await JobApplication.countDocuments({ jobId: job._id });
            return { ...job.toObject(), totalApplications: appCount };
        }));
        res.json(jobsWithCounts);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update job
router.put("/update/:id", authMiddleware, isAdminOrEmployee, async (req, res) => {
    try {
        const job = await Job.findById(req.params.id);
        if (!job) return res.status(404).json({ message: "Job not found" });
        
        if (req.user.role !== "admin" && job.postedBy.toString() !== req.userId) {
            return res.status(403).json({ message: "You can only edit your own jobs" });
        }

        const updatedJob = await Job.findByIdAndUpdate(
            req.params.id,
            { ...req.body, updatedAt: Date.now() },
            { new: true, runValidators: true }
        );

        res.json({ message: "Job updated successfully", data: updatedJob });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Toggle job status
router.patch("/toggle/:id", authMiddleware, isAdminOrEmployee, async (req, res) => {
    try {
        const job = await Job.findById(req.params.id);
        if (!job) return res.status(404).json({ message: "Job not found" });
        
        if (req.user.role !== "admin" && job.postedBy.toString() !== req.userId) {
            return res.status(403).json({ message: "You can only toggle your own jobs" });
        }

        job.active = !job.active;
        await job.save();
        
        res.json({ message: `Job ${job.active ? 'activated' : 'deactivated'}`, active: job.active });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete job
router.delete("/delete/:id", authMiddleware, isAdminOrEmployee, async (req, res) => {
    try {
        const job = await Job.findById(req.params.id);
        if (!job) return res.status(404).json({ message: "Job not found" });
        
        if (req.user.role !== "admin" && job.postedBy.toString() !== req.userId) {
            return res.status(403).json({ message: "You can only delete your own jobs" });
        }
        
        // Delete all applications and their resumes from Cloudinary
        const applications = await JobApplication.find({ jobId: req.params.id });
        for (const app of applications) {
            if (app.resumePublicId) {
                await cloudinary.uploader.destroy(app.resumePublicId, { resource_type: "raw" });
            }
        }
        
        await JobApplication.deleteMany({ jobId: req.params.id });
        await Job.findByIdAndDelete(req.params.id);
        res.json({ message: "Job deleted successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== PUBLIC JOB ROUTES ====================

// Get all active jobs with advanced search
router.get("/public/all", async (req, res) => {
    try {
        const { 
            search, department, category, type, locationType, experienceLevel,
            location, minSalary, maxSalary, page = 1, limit = 20 
        } = req.query;
        
        let query = { active: true, applicationDeadline: { $gte: new Date() } };

        if (search) {
            query.$or = [
                { title: { $regex: search, $options: 'i' } },
                { department: { $regex: search, $options: 'i' } },
                { description: { $regex: search, $options: 'i' } },
                { skills: { $in: [new RegExp(search, 'i')] } },
                { companyName: { $regex: search, $options: 'i' } }
            ];
        }
        if (department) query.department = department;
        if (category) query.category = category;
        if (type) query.type = type;
        if (locationType) query.locationType = locationType;
        if (experienceLevel) query.experienceLevel = experienceLevel;
        if (location) query.location = { $regex: location, $options: 'i' };
        if (minSalary) query.salaryMin = { $gte: parseInt(minSalary) };
        if (maxSalary) query.salaryMax = { $lte: parseInt(maxSalary) };

        const skip = (parseInt(page) - 1) * parseInt(limit);
        
        const [jobs, total] = await Promise.all([
            Job.find(query)
                .sort({ featured: -1, urgent: -1, createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit)),
            Job.countDocuments(query)
        ]);

        // Increment view count
        await Job.updateMany({ _id: { $in: jobs.map(j => j._id) } }, { $inc: { views: 1 } });

        res.json({
            jobs,
            total,
            page: parseInt(page),
            totalPages: Math.ceil(total / parseInt(limit))
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get single job details
router.get("/public/job/:id", async (req, res) => {
    try {
        const job = await Job.findOne({ _id: req.params.id, active: true });
        if (!job) return res.status(404).json({ message: "Job not found" });
        
        await Job.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } });
        res.json(job);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get filter options
router.get("/public/filters", async (req, res) => {
    try {
        const departments = await Job.distinct("department", { active: true });
        const categories = await Job.distinct("category", { active: true });
        const types = await Job.distinct("type", { active: true });
        const locations = await Job.distinct("location", { active: true });
        const locationTypes = await Job.distinct("locationType", { active: true });
        const experienceLevels = await Job.distinct("experienceLevel", { active: true });
        
        res.json({ departments, categories, types, locations, locationTypes, experienceLevels });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== APPLICATION ROUTES ====================

// Apply for a job with resume upload to Cloudinary
router.post("/apply/:jobId", authMiddleware, uploadResume.single('resume'), async (req, res) => {
    try {
        const { jobId } = req.params;
        const {
            fullName, email, phone, address, city, country, coverLetter, portfolioUrl,
            linkedInUrl, githubUrl, currentCompany, currentPosition,
            yearsOfExperience, expectedSalary, noticePeriod, availableFrom, workAuthorization
        } = req.body;

        const job = await Job.findOne({ _id: jobId, active: true });
        if (!job) return res.status(404).json({ message: "Job not found" });

        const existingApplication = await JobApplication.findOne({ jobId, userId: req.userId });
        if (existingApplication) {
            return res.status(400).json({ message: "You have already applied for this position" });
        }

        const applicationData = {
            jobId, 
            userId: req.userId, 
            fullName, 
            email, 
            phone, 
            address: address || "",
            city: city || "",
            country: country || "",
            coverLetter, 
            portfolioUrl: portfolioUrl || "",
            linkedInUrl: linkedInUrl || "",
            githubUrl: githubUrl || "",
            currentCompany: currentCompany || "",
            currentPosition: currentPosition || "",
            yearsOfExperience: parseInt(yearsOfExperience) || 0,
            expectedSalary: expectedSalary || "",
            noticePeriod: noticePeriod || "",
            availableFrom: availableFrom ? new Date(availableFrom) : null,
            workAuthorization: workAuthorization || "Citizen", 
            status: "pending",
        };

        if (req.file) {
            applicationData.resumeUrl = req.file.path;
            applicationData.resumePublicId = req.file.filename;
            applicationData.resumeFileName = req.file.originalname;
        }

        const application = new JobApplication(applicationData);
        await application.save();
        await Job.findByIdAndUpdate(jobId, { $inc: { totalApplications: 1 } });

        // Notifications
        await Notification.create({
            recipient: job.postedBy,
            title: "New Job Application! 🎯",
            description: `${fullName} applied for ${job.title}`,
            type: "Job Application",
            icon: "briefcase",
            metadata: { jobId: job._id, applicationId: application._id }
        });

        await Notification.create({
            recipient: req.userId,
            title: "Application Submitted! ✅",
            description: `Your application for ${job.title} has been submitted.`,
            type: "System",
            icon: "checkmark-circle"
        });

        res.status(201).json({ 
            message: "Application submitted successfully", 
            application 
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Get my applications
router.get("/my-applications", authMiddleware, async (req, res) => {
    try {
        const applications = await JobApplication.find({ userId: req.userId })
            .populate('jobId', 'title department location type salary companyName companyLogo')
            .sort({ appliedAt: -1 });
        res.json(applications);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get resume download URL from Cloudinary
router.get("/resume/:applicationId", authMiddleware, async (req, res) => {
    try {
        const application = await JobApplication.findById(req.params.applicationId);
        if (!application) return res.status(404).json({ message: "Application not found" });
        
        const job = await Job.findById(application.jobId);
        if (req.user.role !== "admin" && job.postedBy.toString() !== req.userId && application.userId.toString() !== req.userId) {
            return res.status(403).json({ message: "Access denied" });
        }
        
        if (!application.resumeUrl) return res.status(404).json({ message: "No resume uploaded" });
        
        // Return the Cloudinary URL
        res.json({ resumeUrl: application.resumeUrl, fileName: application.resumeFileName });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get applications for a job
router.get("/job/:jobId/applications", authMiddleware, async (req, res) => {
    try {
        const job = await Job.findById(req.params.jobId);
        if (!job) return res.status(404).json({ message: "Job not found" });
        
        if (req.user.role !== "admin" && job.postedBy.toString() !== req.userId) {
            return res.status(403).json({ message: "Access denied" });
        }
        
        const applications = await JobApplication.find({ jobId: req.params.jobId })
            .populate('userId', 'name email profileImage')
            .sort({ appliedAt: -1 });
        
        res.json(applications);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update application status
router.patch("/application/:id/status", authMiddleware, async (req, res) => {
    try {
        const { status, notes, interviewDate, interviewNotes, rating } = req.body;
        const application = await JobApplication.findById(req.params.id).populate('jobId');
        
        if (!application) return res.status(404).json({ message: "Application not found" });
        
        const job = await Job.findById(application.jobId._id);
        if (req.user.role !== "admin" && job.postedBy.toString() !== req.userId) {
            return res.status(403).json({ message: "Only the job poster can update application status" });
        }
        
        application.status = status;
        if (notes) application.notes = notes;
        if (interviewDate) application.interviewDate = new Date(interviewDate);
        if (interviewNotes) application.interviewNotes = interviewNotes;
        if (rating) application.rating = rating;
        application.reviewedAt = Date.now();
        application.lastUpdated = Date.now();
        
        await application.save();
        
        let statusMessage = "";
        let icon = "information-circle";
        switch(status) {
            case "shortlisted":
                statusMessage = "Congratulations! You've been shortlisted. We'll contact you soon for an interview.";
                icon = "trophy";
                break;
            case "interview":
                statusMessage = `Interview scheduled for ${new Date(interviewDate).toLocaleDateString()}. ${interviewNotes || "Please check your email for details."}`;
                icon = "calendar";
                break;
            case "rejected":
                statusMessage = "Thank you for your interest. We've decided to move forward with other candidates.";
                icon = "alert-circle";
                break;
            case "hired":
                statusMessage = "Congratulations! Welcome to the team! HR will contact you with onboarding details.";
                icon = "checkmark-circle";
                break;
            default:
                statusMessage = `Your application status has been updated to ${status}`;
        }
        
        await Notification.create({
            recipient: application.userId,
            title: `Application Update - ${application.jobId.title}`,
            description: statusMessage,
            type: "Application Status",
            icon: icon
        });
        
        res.json({ message: "Application status updated", application });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get statistics
router.get("/admin/stats", authMiddleware, async (req, res) => {
    try {
        let query = {};
        if (req.user.role !== "admin") {
            const myJobs = await Job.find({ postedBy: req.userId }).select('_id');
            query = { jobId: { $in: myJobs.map(j => j._id) } };
        }
        
        const totalJobs = req.user.role === "admin" ? await Job.countDocuments() : await Job.countDocuments({ postedBy: req.userId });
        const activeJobs = req.user.role === "admin" ? await Job.countDocuments({ active: true }) : await Job.countDocuments({ postedBy: req.userId, active: true });
        const totalApplications = await JobApplication.countDocuments(query);
        const pendingApplications = await JobApplication.countDocuments({ ...query, status: "pending" });
        const shortlistedApplications = await JobApplication.countDocuments({ ...query, status: "shortlisted" });
        const hiredApplications = await JobApplication.countDocuments({ ...query, status: "hired" });
        
        const last7Days = [];
        for (let i = 6; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            date.setHours(0, 0, 0, 0);
            const nextDate = new Date(date);
            nextDate.setDate(nextDate.getDate() + 1);
            
            const count = await JobApplication.countDocuments({
                ...query,
                appliedAt: { $gte: date, $lt: nextDate }
            });
            
            last7Days.push({ date: date.toLocaleDateString('en-US', { weekday: 'short' }), count });
        }
        
        const jobsByDepartment = req.user.role === "admin" 
            ? await Job.aggregate([{ $group: { _id: "$department", count: { $sum: 1 } } }])
            : await Job.aggregate([{ $match: { postedBy: req.user._id } }, { $group: { _id: "$department", count: { $sum: 1 } } }]);
        
        res.json({
            totalJobs, activeJobs, totalApplications, pendingApplications,
            shortlistedApplications, hiredApplications, weeklyApplications: last7Days,
            jobsByDepartment, userRole: req.user.role
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ==================== INTERVIEW MANAGEMENT ROUTES ====================

// Get all interviews (Admin/Employer)
router.get("/interviews/all", authMiddleware, async (req, res) => {
    try {
        let query = {};
        
        // If not admin, only show interviews for their jobs
        if (req.user.role !== "admin") {
            const myJobs = await Job.find({ postedBy: req.userId }).select('_id');
            const jobIds = myJobs.map(job => job._id);
            query = { jobId: { $in: jobIds } };
        }
        
        const interviews = await JobApplication.find({ 
            ...query, 
            interviewDate: { $exists: true, $ne: null }
        })
        .populate('jobId', 'title department location companyName')
        .sort({ interviewDate: 1 });
        
        res.json(interviews);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Get upcoming interviews
router.get("/interviews/upcoming", authMiddleware, async (req, res) => {
    try {
        let query = { 
            interviewDate: { $gte: new Date(), $exists: true, $ne: null }
        };
        
        // If not admin, only show interviews for their jobs
        if (req.user.role !== "admin") {
            const myJobs = await Job.find({ postedBy: req.userId }).select('_id');
            const jobIds = myJobs.map(job => job._id);
            query.jobId = { $in: jobIds };
        }
        
        const upcomingInterviews = await JobApplication.find(query)
            .populate('jobId', 'title department location companyName')
            .sort({ interviewDate: 1 })
            .limit(10);
        
        res.json(upcomingInterviews);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Schedule an interview - FIXED
router.post("/interviews/schedule", authMiddleware, async (req, res) => {
    try {
        const { applicationId, interviewDate, interviewNotes, meetingLink } = req.body;
        
        if (!applicationId || !interviewDate) {
            return res.status(400).json({ message: "Application ID and interview date are required" });
        }
        
        const application = await JobApplication.findById(applicationId).populate('jobId');
        if (!application) {
            return res.status(404).json({ message: "Application not found" });
        }
        
        // Check permission
        const job = await Job.findById(application.jobId._id);
        if (req.user.role !== "admin" && job.postedBy.toString() !== req.userId) {
            return res.status(403).json({ message: "You don't have permission to schedule interviews for this job" });
        }
        
        // Update application with interview details
        application.interviewDate = new Date(interviewDate);
        application.interviewNotes = interviewNotes || "";
        application.status = "interview";
        application.lastUpdated = Date.now();
        
        // Add meeting link if provided
        if (meetingLink) {
            application.meetingLink = meetingLink;
        }
        
        await application.save();
        
        // Send notification to candidate
        await Notification.create({
            recipient: application.userId,
            title: "Interview Scheduled! 🎯",
            description: `Your interview for ${application.jobId.title} has been scheduled for ${new Date(interviewDate).toLocaleString()}. ${interviewNotes || "Please check your email for details."}`,
            type: "Interview",
            icon: "calendar",
            metadata: { 
                jobId: application.jobId._id, 
                applicationId: application._id,
                interviewDate: interviewDate
            }
        });
        
        res.json({ 
            message: "Interview scheduled successfully", 
            application 
        });
    } catch (err) {
        console.error("Error scheduling interview:", err);
        res.status(500).json({ error: err.message });
    }
});

// Reschedule an interview - FIXED
router.put("/interviews/reschedule/:id", authMiddleware, async (req, res) => {
    try {
        const { interviewDate, interviewNotes, meetingLink } = req.body;
        const application = await JobApplication.findById(req.params.id).populate('jobId');
        
        if (!application) {
            return res.status(404).json({ message: "Application not found" });
        }
        
        if (!interviewDate) {
            return res.status(400).json({ message: "Interview date is required" });
        }
        
        // Check permission
        const job = await Job.findById(application.jobId._id);
        if (req.user.role !== "admin" && job.postedBy.toString() !== req.userId) {
            return res.status(403).json({ message: "You don't have permission to reschedule this interview" });
        }
        
        application.interviewDate = new Date(interviewDate);
        if (interviewNotes) application.interviewNotes = interviewNotes;
        if (meetingLink) application.meetingLink = meetingLink;
        application.lastUpdated = Date.now();
        
        await application.save();
        
        // Send notification about reschedule
        await Notification.create({
            recipient: application.userId,
            title: "Interview Rescheduled 🔄",
            description: `Your interview for ${application.jobId.title} has been rescheduled to ${new Date(interviewDate).toLocaleString()}.`,
            type: "Interview",
            icon: "calendar",
            metadata: { 
                jobId: application.jobId._id, 
                applicationId: application._id,
                interviewDate: interviewDate
            }
        });
        
        res.json({ 
            message: "Interview rescheduled successfully", 
            application 
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Cancel an interview - FIXED
router.delete("/interviews/cancel/:id", authMiddleware, async (req, res) => {
    try {
        const application = await JobApplication.findById(req.params.id).populate('jobId');
        
        if (!application) {
            return res.status(404).json({ message: "Application not found" });
        }
        
        // Check permission
        const job = await Job.findById(application.jobId._id);
        if (req.user.role !== "admin" && job.postedBy.toString() !== req.userId) {
            return res.status(403).json({ message: "You don't have permission to cancel this interview" });
        }
        
        const oldInterviewDate = application.interviewDate;
        
        // Remove interview details
        application.interviewDate = null;
        application.interviewNotes = "";
        application.status = "reviewed";
        application.lastUpdated = Date.now();
        
        await application.save();
        
        // Send notification about cancellation
        await Notification.create({
            recipient: application.userId,
            title: "Interview Cancelled ❌",
            description: `Your interview for ${application.jobId.title} scheduled for ${oldInterviewDate ? new Date(oldInterviewDate).toLocaleString() : "the scheduled time"} has been cancelled.`,
            type: "Interview",
            icon: "alert-circle"
        });
        
        res.json({ message: "Interview cancelled successfully" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Mark interview as completed - FIXED
router.patch("/interviews/complete/:id", authMiddleware, async (req, res) => {
    try {
        const { feedback, rating } = req.body;
        const application = await JobApplication.findById(req.params.id).populate('jobId');
        
        if (!application) {
            return res.status(404).json({ message: "Application not found" });
        }
        
        // Check permission
        const job = await Job.findById(application.jobId._id);
        if (req.user.role !== "admin" && job.postedBy.toString() !== req.userId) {
            return res.status(403).json({ message: "You don't have permission to complete this interview" });
        }
        
        application.interviewNotes = feedback || application.interviewNotes;
        if (rating) application.rating = rating;
        application.status = "reviewed";
        application.lastUpdated = Date.now();
        
        await application.save();
        
        res.json({ message: "Interview marked as completed", application });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== CANDIDATE MANAGEMENT ROUTES ====================

// Get all candidates with filters - FIXED
router.get("/candidates/all", authMiddleware, async (req, res) => {
    try {
        const { status, jobId, search, limit = 50 } = req.query;
        let query = {};
        
        // If not admin, only show candidates for their jobs
        if (req.user.role !== "admin") {
            const myJobs = await Job.find({ postedBy: req.userId }).select('_id');
            const jobIds = myJobs.map(job => job._id);
            query.jobId = { $in: jobIds };
        }
        
        if (status && status !== "all") query.status = status;
        if (jobId) query.jobId = jobId;
        if (search) {
            query.$or = [
                { fullName: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } },
                { phone: { $regex: search, $options: 'i' } }
            ];
        }
        
        const candidates = await JobApplication.find(query)
            .populate('jobId', 'title department location companyName salary')
            .sort({ appliedAt: -1 })
            .limit(parseInt(limit));
        
        res.json(candidates);
    } catch (err) {
        console.error("Error fetching candidates:", err);
        res.status(500).json({ error: err.message });
    }
});

// Get single candidate details
router.get("/candidates/:id", authMiddleware, async (req, res) => {
    try {
        const candidate = await JobApplication.findById(req.params.id)
            .populate('jobId', 'title department location companyName salary description requirements');
        
        if (!candidate) {
            return res.status(404).json({ message: "Candidate not found" });
        }
        
        // Check permission
        const job = await Job.findById(candidate.jobId._id);
        if (req.user.role !== "admin" && job.postedBy.toString() !== req.userId && candidate.userId.toString() !== req.userId) {
            return res.status(403).json({ message: "Access denied" });
        }
        
        res.json(candidate);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Bulk update candidate statuses
router.patch("/candidates/bulk-status", authMiddleware, async (req, res) => {
    try {
        const { candidateIds, status, notes } = req.body;
        
        if (!candidateIds || !candidateIds.length) {
            return res.status(400).json({ message: "No candidates selected" });
        }
        
        const applications = await JobApplication.find({ _id: { $in: candidateIds } }).populate('jobId');
        
        // Check permissions for each application
        for (const app of applications) {
            const job = await Job.findById(app.jobId._id);
            if (req.user.role !== "admin" && job.postedBy.toString() !== req.userId) {
                return res.status(403).json({ message: `You don't have permission to update candidate ${app.fullName}` });
            }
        }
        
        // Update all applications
        await JobApplication.updateMany(
            { _id: { $in: candidateIds } },
            { 
                status: status, 
                notes: notes || "",
                reviewedAt: Date.now(),
                lastUpdated: Date.now()
            }
        );
        
        // Send notifications to candidates
        for (const app of applications) {
            let statusMessage = "";
            switch(status) {
                case "shortlisted":
                    statusMessage = "Congratulations! You've been shortlisted for the position.";
                    break;
                case "rejected":
                    statusMessage = "Thank you for your interest. After careful review, we've decided to move forward with other candidates.";
                    break;
                case "hired":
                    statusMessage = "Congratulations! You've been selected for the position. HR will contact you soon.";
                    break;
                default:
                    statusMessage = `Your application status has been updated to ${status}`;
            }
            
            await Notification.create({
                recipient: app.userId,
                title: `Application Status Update - ${app.jobId.title}`,
                description: statusMessage,
                type: "Application Status",
                icon: status === "shortlisted" ? "trophy" : "information-circle"
            });
        }
        
        res.json({ message: `${applications.length} candidates updated successfully` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Export candidates data
router.get("/candidates/export", authMiddleware, async (req, res) => {
    try {
        let query = {};
        
        if (req.user.role !== "admin") {
            const myJobs = await Job.find({ postedBy: req.userId }).select('_id');
            const jobIds = myJobs.map(job => job._id);
            query.jobId = { $in: jobIds };
        }
        
        const candidates = await JobApplication.find(query)
            .populate('jobId', 'title department location')
            .sort({ appliedAt: -1 });
        
        // Format for CSV export
        const exportData = candidates.map(c => ({
            'Full Name': c.fullName,
            'Email': c.email,
            'Phone': c.phone,
            'Position': c.jobId?.title,
            'Department': c.jobId?.department,
            'Experience': c.yearsOfExperience,
            'Current Company': c.currentCompany,
            'Status': c.status,
            'Applied Date': new Date(c.appliedAt).toLocaleDateString(),
            'Cover Letter': c.coverLetter?.substring(0, 100)
        }));
        
        res.json(exportData);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});
// Get statistics - UPDATE THIS SECTION
router.get("/admin/stats", authMiddleware, async (req, res) => {
    try {
        let query = {};
        
        // If not admin, only show stats for their jobs
        if (req.user.role !== "admin") {
            const myJobs = await Job.find({ postedBy: req.userId }).select('_id');
            const jobIds = myJobs.map(job => job._id);
            query = { jobId: { $in: jobIds } };
        }
        
        const totalJobs = req.user.role === "admin" ? await Job.countDocuments() : await Job.countDocuments({ postedBy: req.userId });
        const activeJobs = req.user.role === "admin" ? await Job.countDocuments({ active: true }) : await Job.countDocuments({ postedBy: req.userId, active: true });
        const totalApplications = await JobApplication.countDocuments(query);
        const pendingApplications = await JobApplication.countDocuments({ ...query, status: "pending" });
        const shortlistedApplications = await JobApplication.countDocuments({ ...query, status: "shortlisted" });
        const hiredApplications = await JobApplication.countDocuments({ ...query, status: "hired" });
        
        // FIX: Get total interviews (applications with interview date)
        const totalInterviews = await JobApplication.countDocuments({ 
            ...query, 
            interviewDate: { $exists: true, $ne: null } 
        });
        
        // FIX: Get upcoming interviews (future interviews)
        const upcomingInterviews = await JobApplication.countDocuments({ 
            ...query, 
            interviewDate: { $gte: new Date(), $exists: true, $ne: null } 
        });
        
        const last7Days = [];
        for (let i = 6; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            date.setHours(0, 0, 0, 0);
            const nextDate = new Date(date);
            nextDate.setDate(nextDate.getDate() + 1);
            
            const count = await JobApplication.countDocuments({
                ...query,
                appliedAt: { $gte: date, $lt: nextDate }
            });
            
            last7Days.push({ date: date.toLocaleDateString('en-US', { weekday: 'short' }), count });
        }
        
        const jobsByDepartment = req.user.role === "admin" 
            ? await Job.aggregate([{ $group: { _id: "$department", count: { $sum: 1 } } }])
            : await Job.aggregate([{ $match: { postedBy: req.user._id } }, { $group: { _id: "$department", count: { $sum: 1 } } }]);
        
        res.json({
            totalJobs, 
            activeJobs, 
            totalApplications, 
            pendingApplications,
            shortlistedApplications, 
            hiredApplications,
            totalInterviews,        // ADD THIS
            upcomingInterviews,     // ADD THIS
            weeklyApplications: last7Days,
            jobsByDepartment, 
            userRole: req.user.role
        });
    } catch (err) {
        console.error("Stats error:", err);
        res.status(500).json({ error: err.message });
    }
});
// Helper function
function getStatusColor(status) {
    const colors = {
        pending: "#f59e0b",
        reviewed: "#3b82f6",
        shortlisted: "#10b981",
        interview: "#8b5cf6",
        rejected: "#ef4444",
        hired: "#059669"
    };
    return colors[status] || "#6b7280";
}

module.exports = router;