// routes/resume.routes.js
const express = require('express');
const router = express.Router();
const Resume = require('../models/Resume');
const auth = require('../middleware/auth.middleware');
const path = require('path');
const fs = require('fs');
const { uploadResume, deleteFromCloudinary } = require('../config/cloudinary');
const { parseResumePDF } = require('../services/resumeParser');

// Check resume limit
const checkResumeLimit = async (req, res, next) => {
  try {
    const count = await Resume.countDocuments({ user: req.user._id });
    if (count >= 5) {
      return res.status(400).json({
        success: false,
        error: 'Maximum 5 resumes allowed per user'
      });
    }
    next();
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// ========== CREATE RESUME ==========
router.post('/', auth, checkResumeLimit, async (req, res) => {
  try {
    console.log('📝 Create resume request received');
    console.log('📊 User ID:', req.user._id);

    const cleanData = {
      user: req.user._id,
    };

    if (req.body.personalInfo) {
      cleanData.personalInfo = {
        firstName: req.body.personalInfo.firstName || '',
        lastName: req.body.personalInfo.lastName || '',
        email: req.body.personalInfo.email || '',
        phone: req.body.personalInfo.phone || '',
        address: req.body.personalInfo.address || '',
        city: req.body.personalInfo.city || '',
        state: req.body.personalInfo.state || '',
        country: req.body.personalInfo.country || '',
        postalCode: req.body.personalInfo.postalCode || '',
        linkedin: req.body.personalInfo.linkedin || '',
        github: req.body.personalInfo.github || '',
        portfolio: req.body.personalInfo.portfolio || ''
      };
    } else {
      cleanData.personalInfo = {};
    }

    if (req.body.professionalSummary) {
      cleanData.professionalSummary = {
        title: req.body.professionalSummary.title || '',
        summary: req.body.professionalSummary.summary || '',
        experienceLevel: req.body.professionalSummary.experienceLevel || 'Mid Level'
      };
    } else {
      cleanData.professionalSummary = {};
    }

    if (req.body.targetJob) {
      cleanData.targetJob = {
        jobTitle: req.body.targetJob.jobTitle || '',
        industry: req.body.targetJob.industry || '',
        jobType: req.body.targetJob.jobType || 'Full-time',
        desiredSalary: req.body.targetJob.desiredSalary || '',
        location: req.body.targetJob.location || '',
        availability: req.body.targetJob.availability || ''
      };
    } else {
      cleanData.targetJob = {};
    }

    if (req.body.targetJobs && Array.isArray(req.body.targetJobs)) {
      cleanData.targetJobs = req.body.targetJobs.filter(job => job.jobTitle && job.jobTitle.trim() !== '');
    } else {
      cleanData.targetJobs = [];
    }

    if (req.body.settings) {
      cleanData.settings = {
        visibility: req.body.settings.visibility || 'public',
        allowDownload: req.body.settings.allowDownload !== undefined ? req.body.settings.allowDownload : true,
        allowSharing: req.body.settings.allowSharing !== undefined ? req.body.settings.allowSharing : true,
        showContactInfo: req.body.settings.showContactInfo !== undefined ? req.body.settings.showContactInfo : true,
        showSocialLinks: req.body.settings.showSocialLinks !== undefined ? req.body.settings.showSocialLinks : true,
        showSkills: req.body.settings.showSkills !== undefined ? req.body.settings.showSkills : true,
        showExperience: req.body.settings.showExperience !== undefined ? req.body.settings.showExperience : true,
        showEducation: req.body.settings.showEducation !== undefined ? req.body.settings.showEducation : true,
        showCertifications: req.body.settings.showCertifications !== undefined ? req.body.settings.showCertifications : true,
        showProjects: req.body.settings.showProjects !== undefined ? req.body.settings.showProjects : true,
        showLanguages: req.body.settings.showLanguages !== undefined ? req.body.settings.showLanguages : true,
        showInterests: req.body.settings.showInterests !== undefined ? req.body.settings.showInterests : true,
        showReferences: req.body.settings.showReferences !== undefined ? req.body.settings.showReferences : true,
        fontSize: req.body.settings.fontSize || 'medium',
        colorScheme: req.body.settings.colorScheme || 'blue',
        language: req.body.settings.language || 'en',
        autoSave: req.body.settings.autoSave !== undefined ? req.body.settings.autoSave : true,
        saveInterval: req.body.settings.saveInterval || 30,
        defaultTemplate: req.body.settings.defaultTemplate || 'modern'
      };
    }

    const arrayFields = ['education', 'skills', 'workExperience', 'certifications', 'projects', 'languages', 'references', 'interests'];
    arrayFields.forEach(field => {
      if (req.body[field] && Array.isArray(req.body[field])) {
        cleanData[field] = req.body[field].filter(item => item && Object.keys(item).length > 0);
      } else {
        cleanData[field] = [];
      }
    });

    cleanData.template = req.body.template || 'modern';

    const resume = new Resume(cleanData);
    await resume.save();

    console.log('✅ Resume created successfully:', resume._id);

    res.status(201).json({
      success: true,
      data: resume,
      message: 'Resume created successfully'
    });
  } catch (error) {
    console.error('❌ Create resume error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to create resume'
    });
  }
});

// ========== GET ALL RESUMES ==========
router.get('/', auth, async (req, res) => {
  try {
    const resumes = await Resume.find({ user: req.user._id })
      .sort({ updatedAt: -1 });

    res.json({
      success: true,
      data: resumes
    });
  } catch (error) {
    console.error('Get resumes error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to fetch resumes' 
    });
  }
});

// ========== GET SINGLE RESUME ==========
router.get('/:id', auth, async (req, res) => {
  try {
    const resume = await Resume.findOne({ 
      _id: req.params.id, 
      user: req.user._id 
    });

    if (!resume) {
      return res.status(404).json({
        success: false,
        error: 'Resume not found'
      });
    }

    await resume.trackView();

    res.json({
      success: true,
      data: resume
    });
  } catch (error) {
    console.error('Get resume error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to fetch resume' 
    });
  }
});

// ========== UPDATE RESUME ==========
router.put('/:id', auth, async (req, res) => {
  try {
    console.log('📝 Update resume request:', req.params.id);

    const resume = await Resume.findOne({ 
      _id: req.params.id, 
      user: req.user._id 
    });

    if (!resume) {
      return res.status(404).json({
        success: false,
        error: 'Resume not found'
      });
    }

    if (req.body.personalInfo) {
      resume.personalInfo = {
        ...resume.personalInfo,
        ...req.body.personalInfo
      };
    }

    if (req.body.professionalSummary) {
      resume.professionalSummary = {
        ...resume.professionalSummary,
        ...req.body.professionalSummary
      };
    }

    if (req.body.targetJob) {
      resume.targetJob = {
        ...resume.targetJob,
        ...req.body.targetJob
      };
    }

    if (req.body.targetJobs !== undefined) {
      resume.targetJobs = req.body.targetJobs;
    }

    if (req.body.settings) {
      resume.settings = {
        ...resume.settings,
        ...req.body.settings
      };
    }

    const arrayFields = ['education', 'skills', 'workExperience', 'certifications', 'projects', 'languages', 'references', 'interests'];
    arrayFields.forEach(field => {
      if (req.body[field] !== undefined) {
        resume[field] = req.body[field];
      }
    });

    if (req.body.template) {
      resume.template = req.body.template;
    }

    if (req.body.uploadedResume) {
      resume.uploadedResume = {
        ...resume.uploadedResume,
        ...req.body.uploadedResume
      };
    }

    await resume.save();

    console.log('✅ Resume updated successfully:', resume._id);

    res.json({
      success: true,
      data: resume,
      message: 'Resume updated successfully'
    });
  } catch (error) {
    console.error('❌ Update resume error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to update resume'
    });
  }
});

// ========== DELETE RESUME ==========
router.delete('/:id', auth, async (req, res) => {
  try {
    const resume = await Resume.findOne({ 
      _id: req.params.id, 
      user: req.user._id 
    });

    if (!resume) {
      return res.status(404).json({
        success: false,
        error: 'Resume not found'
      });
    }

    // Delete from Cloudinary if exists
    if (resume.uploadedResume && resume.uploadedResume.publicId) {
      await deleteFromCloudinary(resume.uploadedResume.publicId, 'raw');
    }

    await Resume.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: 'Resume deleted successfully'
    });
  } catch (error) {
    console.error('Delete resume error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to delete resume' 
    });
  }
});

// ========== UPLOAD RESUME TO CLOUDINARY ==========
router.post('/upload', auth, uploadResume.single('resume'), async (req, res) => {
  try {
    console.log('📄 Upload resume request received');
    
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded'
      });
    }

    console.log('📁 File received:', req.file.originalname);
    console.log('📏 File size:', req.file.size);
    console.log('☁️ Cloudinary URL:', req.file.path);
    console.log('🆔 Public ID:', req.file.filename);

    const count = await Resume.countDocuments({ user: req.user._id });
    if (count >= 5) {
      await deleteFromCloudinary(req.file.filename, 'raw');
      return res.status(400).json({
        success: false,
        error: 'Maximum 5 resumes allowed per user'
      });
    }

    let parsedData = {};
    try {
      console.log('🔍 Starting PDF parsing...');
      parsedData = await parseResumePDF(req.file.path);
      console.log('✅ PDF parsing completed successfully');
      console.log('📊 Parsed data summary:', {
        name: parsedData.personalInfo?.firstName,
        education: parsedData.education?.length || 0,
        skills: parsedData.skills?.length || 0,
        experience: parsedData.workExperience?.length || 0,
        certifications: parsedData.certifications?.length || 0,
        projects: parsedData.projects?.length || 0,
        languages: parsedData.languages?.length || 0,
      });
    } catch (parseError) {
      console.error('❌ Parse error:', parseError);
    }

    const resumeData = {
      user: req.user._id,
      personalInfo: {
        firstName: parsedData.personalInfo?.firstName || '',
        lastName: parsedData.personalInfo?.lastName || '',
        email: parsedData.personalInfo?.email || '',
        phone: parsedData.personalInfo?.phone || '',
        address: parsedData.personalInfo?.address || '',
        city: parsedData.personalInfo?.city || '',
        state: parsedData.personalInfo?.state || '',
        country: parsedData.personalInfo?.country || '',
        postalCode: parsedData.personalInfo?.postalCode || '',
        linkedin: parsedData.personalInfo?.linkedin || '',
        github: parsedData.personalInfo?.github || '',
        portfolio: parsedData.personalInfo?.portfolio || ''
      },
      professionalSummary: {
        title: parsedData.professionalSummary?.title || '',
        summary: parsedData.professionalSummary?.summary || '',
        experienceLevel: parsedData.professionalSummary?.experienceLevel || 'Mid Level'
      },
      education: parsedData.education || [],
      skills: parsedData.skills || [],
      workExperience: parsedData.workExperience || [],
      certifications: parsedData.certifications || [],
      projects: parsedData.projects || [],
      languages: parsedData.languages || [],
      uploadedResume: {
        fileName: req.file.originalname,
        fileUrl: req.file.path,
        publicId: req.file.filename,
        uploadDate: new Date(),
        parsedData: parsedData
      }
    };

    const resume = new Resume(resumeData);
    await resume.save();

    const savedResume = await Resume.findById(resume._id);

    console.log('✅ Resume saved successfully:', resume._id);
    console.log('📊 Completion percentage:', savedResume.completionPercentage);

    res.json({
      success: true,
      data: savedResume,
      message: 'Resume uploaded and parsed successfully'
    });
  } catch (error) {
    console.error('❌ Upload resume error:', error);
    if (req.file && req.file.filename) {
      await deleteFromCloudinary(req.file.filename, 'raw');
    }
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to process resume file'
    });
  }
});

// ========== GET RECOMMENDATIONS ==========
router.get('/:id/recommendations', auth, async (req, res) => {
  try {
    const resume = await Resume.findOne({ 
      _id: req.params.id, 
      user: req.user._id 
    });

    if (!resume) {
      return res.status(404).json({
        success: false,
        error: 'Resume not found'
      });
    }

    const recommendations = await Resume.getRecommendedJobs(req.params.id);
    
    res.json({
      success: true,
      data: recommendations
    });
  } catch (error) {
    console.error('Get recommendations error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to get recommendations' 
    });
  }
});

// ========== UPDATE TEMPLATE ==========
router.put('/:id/template', auth, async (req, res) => {
  try {
    const { template } = req.body;
    const validTemplates = ['modern', 'classic', 'creative', 'minimal', 'professional'];

    if (!validTemplates.includes(template)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid template type'
      });
    }

    const resume = await Resume.findOne({ _id: req.params.id, user: req.user._id });
    if (!resume) {
      return res.status(404).json({ success: false, error: 'Resume not found' });
    }

    resume.template = template;
    await resume.save();

    res.json({
      success: true,
      data: resume,
      message: 'Template updated successfully'
    });
  } catch (error) {
    console.error('Update template error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to update template' 
    });
  }
});

// ========== GET ANALYTICS ==========
router.get('/:id/analytics', auth, async (req, res) => {
  try {
    const resume = await Resume.findOne({ 
      _id: req.params.id, 
      user: req.user._id 
    });

    if (!resume) {
      return res.status(404).json({
        success: false,
        error: 'Resume not found'
      });
    }

    const viewHistory = [];
    const now = new Date();
    for (let i = 29; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      date.setHours(0, 0, 0, 0);
      
      const entry = resume.viewsHistory?.find(v => {
        const entryDate = new Date(v.date);
        entryDate.setHours(0, 0, 0, 0);
        return entryDate.getTime() === date.getTime();
      });
      
      viewHistory.push({
        date: date,
        views: entry?.count || 0
      });
    }

    const improvements = [];
    
    if (!resume.personalInfo?.firstName || !resume.personalInfo?.lastName) {
      improvements.push({
        id: 'name',
        title: 'Add Your Full Name',
        description: 'Your name is the first thing recruiters see.',
        priority: 'high'
      });
    }
    
    if (!resume.personalInfo?.email) {
      improvements.push({
        id: 'email',
        title: 'Add Contact Email',
        description: 'Recruiters need a way to reach you.',
        priority: 'high'
      });
    }
    
    if (!resume.professionalSummary?.summary) {
      improvements.push({
        id: 'summary',
        title: 'Add Professional Summary',
        description: 'A strong summary helps recruiters understand your value.',
        priority: 'high'
      });
    }
    
    if (!resume.workExperience || resume.workExperience.length < 1) {
      improvements.push({
        id: 'experience',
        title: 'Add Work Experience',
        description: 'Showcase your professional background.',
        priority: 'medium'
      });
    }
    
    if (!resume.education || resume.education.length < 1) {
      improvements.push({
        id: 'education',
        title: 'Add Education',
        description: 'Complete your profile with educational background.',
        priority: 'medium'
      });
    }
    
    if (!resume.skills || resume.skills.length < 3) {
      improvements.push({
        id: 'skills',
        title: 'Add More Skills',
        description: 'List at least 3-5 skills relevant to your target role.',
        priority: 'medium'
      });
    }

    const analytics = {
      views: resume.viewCount || 0,
      downloads: resume.downloadCount || 0,
      shares: resume.shareCount || 0,
      applications: Math.floor(Math.random() * 20) + 1,
      viewHistory: viewHistory,
      skillMatch: Math.min(85 + Math.floor(Math.random() * 15), 100),
      completeness: resume.completionPercentage || 0,
      strength: resume.isComplete ? 90 : Math.min(50 + (resume.completionPercentage || 0) * 0.5, 85),
      improvements: improvements
    };

    res.json({
      success: true,
      data: analytics
    });
  } catch (error) {
    console.error('Get analytics error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to get analytics' 
    });
  }
});

module.exports = router;