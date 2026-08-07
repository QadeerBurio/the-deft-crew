const express = require('express');
const router = express.Router();
const Resume = require('../models/Resume');
const User   = require('../models/User');
const auth = require('../middleware/auth.middleware');
const path = require('path');
const fs = require('fs');
const { uploadResume, deleteFromCloudinary } = require('../config/cloudinary');
const { parseResumePDF } = require('../services/resumeParser');
const { triggerCareerProfileEnrichment } = require('../services/careerProfileService');
const { invalidateCacheForResume }        = require('../services/skillGapService');
const { tailorResume }                   = require('../services/resumeTailorService');
const { generateResumePDF }              = require('../services/pdfService');
const { optimizeParsedResume }          = require('../services/resumeIntelligenceService');
const OpenAI = require('openai');
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 45000,
  maxRetries: 2
});

// Middleware to reject guest users on write endpoints
const rejectGuest = (req, res, next) => {
  if (req.isGuest || req.user?.isGuest || req.user?.role === 'guest') {
    return res.status(403).json({
      success: false,
      error: 'Guest users cannot perform this action. Please sign up or log in.'
    });
  }
  next();
};

// Check lifetime resume creation limit (Maximum 2 lifetime resume creations per user)
const MAX_LIFETIME_RESUME_CREATIONS = 2;

const checkResumeLimit = async (req, res, next) => {
  try {
    const userDoc = await User.findById(req.user._id);
    let creationCount = userDoc ? userDoc.resumeCreationCount : 0;

    // Auto-migrate existing users who haven't had resumeCreationCount initialized
    if (userDoc && (userDoc.resumeCreationCount === undefined || userDoc.resumeCreationCount === null)) {
      const existingCount = await Resume.countDocuments({ user: req.user._id });
      creationCount = existingCount;
      await User.findByIdAndUpdate(req.user._id, { resumeCreationCount: existingCount });
    }

    if (creationCount >= MAX_LIFETIME_RESUME_CREATIONS) {
      return res.status(403).json({
        success: false,
        code: 'RESUME_CREATION_LIMIT_REACHED',
        error: 'You have used all 2 resume creations available for your account. Deleting a resume will not restore your creation limit.',
        message: 'You have used all 2 resume creations available for your account. Deleting a resume will not restore your creation limit.',
        creationsUsed: creationCount,
        maxCreations: MAX_LIFETIME_RESUME_CREATIONS
      });
    }
    next();
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// ========== CREATE RESUME ==========
router.post('/', auth, rejectGuest, checkResumeLimit, async (req, res) => {
  try {
    console.log('📝 Create resume request received');
    console.log('📊 User ID:', req.user._id);

    const cleanData = {
      user: req.user._id,
    };

    if (req.body.personalInfo) {
      cleanData.personalInfo = {
        firstName: req.body.personalInfo.firstName || req.user?.name?.split(' ')[0] || '',
        lastName: req.body.personalInfo.lastName || req.user?.name?.split(' ')[1] || '',
        title: req.body.personalInfo.title || req.body.professionalSummary?.title || req.user?.headline || '',
        email: req.body.personalInfo.email || req.user?.email || '',
        phone: req.body.personalInfo.phone || req.user?.phone || '',
        location: req.body.personalInfo.location || req.user?.location || '',
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
      cleanData.personalInfo = {
        firstName: req.user?.name?.split(' ')[0] || '',
        lastName: req.user?.name?.split(' ')[1] || '',
        title: req.user?.headline || '',
        email: req.user?.email || '',
        phone: req.user?.phone || '',
        location: req.user?.location || ''
      };
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

    // Increment lifetime creation count for user
    await User.findByIdAndUpdate(req.user._id, { $inc: { resumeCreationCount: 1 } });

    console.log('✅ Resume created successfully:', resume._id);

    // 🧠 Fire-and-forget: AI career profile enrichment (does not block response)
    setImmediate(() => triggerCareerProfileEnrichment(resume._id.toString(), req.user._id.toString()));

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

    const userDoc = await User.findById(req.user._id).select('resumeCreationCount');
    let creationCount = userDoc ? userDoc.resumeCreationCount : 0;
    if (userDoc && (userDoc.resumeCreationCount === undefined || userDoc.resumeCreationCount === null)) {
      creationCount = resumes.length;
      await User.findByIdAndUpdate(req.user._id, { resumeCreationCount: creationCount });
    }

    res.json({
      success: true,
      data: resumes,
      creationsUsed: creationCount,
      maxCreations: 2
    });
  } catch (error) {
    console.error('Get resumes error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to fetch resumes' 
    });
  }
});

// ========== GET PRIMARY RESUME (STATIC PATHS FIRST) ==========
// GET /api/resume/primary
// Returns the user's primary resume (isPrimary=true, else most recently updated)
router.get('/primary', auth, async (req, res) => {
  try {
    let resume = await Resume.findOne({ user: req.user._id, isPrimary: true });
    if (!resume) {
      resume = await Resume.findOne({ user: req.user._id }).sort({ updatedAt: -1 });
    }
    if (!resume) {
      return res.status(404).json({ success: false, error: 'No resume found' });
    }
    res.json({ success: true, data: resume });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ========== AI ENHANCE TEXT (Lightweight) ==========
// POST /api/resume/enhance-text
router.post('/enhance-text', auth, rejectGuest, async (req, res) => {
  try {
    const { text, context } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ success: false, error: 'text is required' });
    }
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are an expert ATS resume writer. Rewrite the given text using strong action verbs, the STAR method, and quantifiable achievements where possible. Return ONLY the rewritten text — no labels, no preamble, no markdown.'
        },
        {
          role: 'user',
          content: `Context: ${context || 'general resume content'}\n\nText to enhance:\n${text.trim()}`
        }
      ],
      max_tokens: 500,
      temperature: 0.7
    });
    const enhanced = completion.choices[0]?.message?.content?.trim() || text;
    res.json({ success: true, enhanced });
  } catch (error) {
    console.error('Enhance text error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to enhance text' });
  }
});

// ========== AI SKILL SUGGESTIONS (Lightweight) ==========
// POST /api/resume/suggest-skills
router.post('/suggest-skills', auth, rejectGuest, async (req, res) => {
  try {
    const { currentSkills, targetRole } = req.body;
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a career advisor. Given the user\'s current skills and their target role, suggest 8-12 highly relevant skills they should add to their resume. Return ONLY a JSON array of skill name strings, no explanation. Example: ["Docker", "Kubernetes", "CI/CD"]'
        },
        {
          role: 'user',
          content: `Target Role: ${targetRole || 'Software Engineer'}\n\nCurrent Skills: ${(currentSkills || []).join(', ') || 'None listed'}\n\nSuggest additional skills to add:`
        }
      ],
      max_tokens: 300,
      temperature: 0.7
    });
    const raw = completion.choices[0]?.message?.content?.trim() || '[]';
    let suggestions = [];
    try {
      const match = raw.match(/\[.*\]/s);
      suggestions = match ? JSON.parse(match[0]) : [];
    } catch {
      suggestions = [];
    }
    res.json({ success: true, suggestions });
  } catch (error) {
    console.error('Skill suggestions error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to get suggestions' });
  }
});

// ========== UPLOAD RESUME TO CLOUDINARY ==========
router.post('/upload', 
  auth, 
  rejectGuest,
  checkResumeLimit,
  (req, res, next) => {
    console.log(`[${new Date().toISOString()}] 📥 File upload request received via Multer`);
    uploadResume.single('resume')(req, res, (err) => {
      if (err) {
        console.error(`[${new Date().toISOString()}] ❌ File validation/upload failed:`, err);
        return res.status(400).json({
          success: false,
          error: err.message || 'File upload failed'
        });
      }
      console.log(`[${new Date().toISOString()}] 💾 File validated and stored: ${req.file ? req.file.originalname : 'None'}`);
      next();
    });
  }, 
  async (req, res) => {
  const startTime = Date.now();
  try {
    console.log(`[${new Date().toISOString()}] 📤 Resume upload processing started`);
    
    if (!req.file) {
      console.warn(`[${new Date().toISOString()}] ⚠️ No file uploaded in request`);
      return res.status(400).json({
        success: false,
        error: 'No file uploaded'
      });
    }

    console.log(`[${new Date().toISOString()}] 📄 File details: Name="${req.file.originalname}", Path="${req.file.path}"`);

    // Parse the resume
    let parsedData = {};
    let parseError = null;
    const parseStart = Date.now();
    try {
      console.log(`[${new Date().toISOString()}] 🔍 Starting PDF/Word text extraction & parsing...`);
      parsedData = await parseResumePDF(req.file.path, req.file.originalname);
      console.log(`[${new Date().toISOString()}] 🟢 PDF text extracted and parsed successfully in ${Date.now() - parseStart}ms`);
    } catch (parsingErr) {
      console.error(`[${new Date().toISOString()}] ❌ Resume parse error after ${Date.now() - parseStart}ms:`, parsingErr);
      parseError = parsingErr.message || 'Parsing failed';
    }

    // Run AI Resume Intelligence Engine Optimization
    let optimizedData = {};
    const optStart = Date.now();
    try {
      console.log(`[${new Date().toISOString()}] 🧠 AI processing started: optimizing parsed resume...`);
      optimizedData = await optimizeParsedResume(parsedData);
      console.log(`[${new Date().toISOString()}] 🟢 AI optimization completed in ${Date.now() - optStart}ms`);
    } catch (optErr) {
      console.error(`[${new Date().toISOString()}] ❌ Resume optimization error after ${Date.now() - optStart}ms:`, optErr);
      optimizedData = parsedData; // Fallback to raw parsed data
    }

    // Generate a unique filename based on original name and timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseName = req.file.originalname.replace(/\.[^/.]+$/, "");
    const uniqueFileName = `${baseName}_${timestamp}`;

    console.log('💾 Creating new resume document...');

    const resumeData = {
      user: req.user._id,
      personalInfo: {
        firstName: parsedData.personalInfo?.firstName || '',
        lastName: parsedData.personalInfo?.lastName || '',
        title: parsedData.personalInfo?.title || parsedData.professionalSummary?.title || optimizedData.targetRole || '',
        email: parsedData.personalInfo?.email || '',
        phone: parsedData.personalInfo?.phone || '',
        location: parsedData.personalInfo?.location || (parsedData.personalInfo?.city ? `${parsedData.personalInfo.city}${parsedData.personalInfo.country ? ', ' + parsedData.personalInfo.country : ''}` : ''),
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
        title: optimizedData.targetRole || parsedData.professionalSummary?.title || 
                (parsedData.personalInfo?.firstName ? 
                  `${parsedData.personalInfo.firstName} ${parsedData.personalInfo.lastName || ''}`.trim() : 'Professional'),
        summary: optimizedData.optimizedSummary || parsedData.professionalSummary?.summary || '',
        experienceLevel: optimizedData.careerLevel || parsedData.professionalSummary?.experienceLevel || 'Mid Level'
      },
      education: parsedData.education || [],
      skills: optimizedData.optimizedSkills || parsedData.skills || [],
      workExperience: optimizedData.optimizedExperience || parsedData.workExperience || [],
      certifications: parsedData.certifications || [],
      projects: optimizedData.optimizedProjects || parsedData.projects || [],
      languages: parsedData.languages || [],
      uploadedResume: {
        fileName: req.file.originalname,
        fileUrl: req.file.path.startsWith('http')
          ? req.file.path
          : `${req.protocol}://${req.get('host')}/uploads/resumes/${req.file.filename}`,
        publicId: req.file.filename,
        uploadDate: new Date(),
        parsedData: parsedData,
        parseError: parseError
      },
      // Set version tag based on content
      versionTag: determineVersionTag(parsedData),
      versionNotes: `Uploaded from ${req.file.originalname} on ${new Date().toLocaleDateString()}`,

      // AI Intelligence Layer fields
      careerLevel: optimizedData.careerLevel || 'Mid Level',
      industry: optimizedData.industry || 'General',
      targetRole: optimizedData.targetRole || parsedData.professionalSummary?.title || 'Professional',
      professionalBrand: optimizedData.professionalBrand || '',
      personalBranding: optimizedData.personalBranding || {
        professionalHeadline: '',
        personalBrandStatement: '',
        coreValueProposition: '',
        professionalIdentity: ''
      },
      careerHighlights: optimizedData.careerHighlights || [],
      coreCompetencies: optimizedData.coreCompetencies || [],
      atsKeywords: optimizedData.atsKeywords || [],
      missingKeywords: optimizedData.missingKeywords || [],
      keywordMatchPercentage: optimizedData.keywordMatchPercentage || 0,
      resumeScores: optimizedData.resumeScores || {
        atsScore: 50,
        recruiterScore: 50,
        contentQuality: 50,
        keywordStrength: 50,
        formattingScore: 50,
        impactScore: 50,
        overallHiringScore: 50
      },
      hrScorecard: optimizedData.hrScorecard || {
        professionalSummaryScore: 5,
        experienceScore: 15,
        projectsScore: 8,
        educationScore: 5,
        skillsScore: 5,
        achievementsScore: 5,
        atsScore: 5,
        formattingScore: 3,
        professionalBrandingScore: 2,
        overallScore: 50
      },
      hiringDecision: optimizedData.hiringDecision || {
        hrShortlist: { status: 'MAYBE', reason: '' },
        hiringManagerInterview: { status: 'MAYBE', reason: '' },
        departmentHeadApprove: { status: 'MAYBE', reason: '' }
      },
      industryBenchmarking: optimizedData.industryBenchmarking || {
        percentileRank: 'Average',
        rankExplanation: ''
      },
      prioritizedImprovementPlan: optimizedData.prioritizedImprovementPlan || [],
      missingSkills: optimizedData.missingSkills || [],
      strengths: optimizedData.strengths || [],
      weaknesses: optimizedData.weaknesses || [],
      optimizedSummary: optimizedData.optimizedSummary || '',
      optimizedExperience: optimizedData.optimizedExperience || parsedData.workExperience || [],
      optimizedProjects: optimizedData.optimizedProjects || parsedData.projects || [],
      optimizedSkills: optimizedData.optimizedSkills || parsedData.skills || [],
      hrRecommendations: optimizedData.hrRecommendations || []
    };

    const dbStart = Date.now();
    const resume = new Resume(resumeData);
    await resume.save();

    // Increment lifetime creation count for user
    await User.findByIdAndUpdate(req.user._id, { $inc: { resumeCreationCount: 1 } });
    console.log(`[${new Date().toISOString()}] 💾 Database updated: Resume saved successfully in ${Date.now() - dbStart}ms (ID: ${resume._id})`);

    // Calculate AI parsing confidence score (0-100)
    let scoreCount = 0;
    let maxScore = 0;
    const personalCheck = ['firstName', 'lastName', 'email', 'phone', 'linkedin', 'github'];
    personalCheck.forEach(field => {
      maxScore += 10;
      if (parsedData.personalInfo?.[field]) scoreCount += 10;
    });
    maxScore += 30;
    if (parsedData.professionalSummary?.summary) scoreCount += 10;
    if (parsedData.skills?.length > 0) scoreCount += 10;
    if (parsedData.workExperience?.length > 0) scoreCount += 10;

    const confidenceScore = maxScore > 0 ? Math.round((scoreCount / maxScore) * 100) : 100;

    // Prepare response data
    const responseData = {
      success: true,
      data: resume,
      confidenceScore: confidenceScore,
      message: 'Resume uploaded and parsed successfully'
    };

    // Add parsing warnings if any
    const warnings = [];
    if (parseError) {
      warnings.push(`Parsing completed with some issues: ${parseError}`);
    }
    if (confidenceScore < 50) {
      warnings.push('Resume parsing had low confidence. Please review and update the extracted information.');
    }
    if (warnings.length > 0) {
      responseData.warning = warnings.join(' | ');
    }

    console.log(`[${new Date().toISOString()}] 📊 Parsing confidence score: ${confidenceScore}%`);

    const totalDuration = Date.now() - startTime;
    console.log(`[${new Date().toISOString()}] 🚀 Response sent. Total request duration: ${totalDuration}ms`);
    res.json(responseData);
  } catch (error) {
    const totalDuration = Date.now() - startTime;
    console.error(`[${new Date().toISOString()}] ❌ Upload resume error after ${totalDuration}ms:`, error);
    if (req.file && req.file.filename) {
      await deleteFromCloudinary(req.file.filename, 'raw');
    }
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to process resume file'
    });
  }
});

// Helper function to determine version tag based on parsed content
function determineVersionTag(parsedData) {
  if (!parsedData || !parsedData.skills) return 'General';
  
  const skills = parsedData.skills.map(s => s.name?.toLowerCase() || '').join(' ');
  const experience = parsedData.workExperience?.map(w => 
    `${w.position || ''} ${w.description || ''}`.toLowerCase()).join(' ') || '';
  const projects = parsedData.projects?.map(p => 
    `${p.name || ''} ${p.description || ''}`.toLowerCase()).join(' ') || '';
  
  const allContent = `${skills} ${experience} ${projects}`;
  
  if (/backend|server|api|node|django|flask|spring|laravel/.test(allContent)) {
    return 'Backend';
  }
  if (/frontend|react|angular|vue|ui|ux|css|html/.test(allContent)) {
    return 'Frontend';
  }
  if (/ai|ml|machine learning|tensorflow|pytorch|data science/.test(allContent)) {
    return 'AI/ML';
  }
  if (/data|analytics|tableau|powerbi|sql|database/.test(allContent)) {
    return 'Data Science';
  }
  if (/devops|docker|kubernetes|aws|azure|ci\/cd|jenkins/.test(allContent)) {
    return 'DevOps';
  }
  if (/mobile|android|ios|flutter|react native/.test(allContent)) {
    return 'Mobile';
  }
  if (/security|cybersecurity|penetration|vulnerability/.test(allContent)) {
    return 'Cybersecurity';
  }
  if (/design|ux|ui|figma|sketch|adobe/.test(allContent)) {
    return 'Design';
  }
  if (/management|manager|lead|director|project/.test(allContent)) {
    return 'Management';
  }
  
  return 'General';
}

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
router.put('/:id', auth, rejectGuest, async (req, res) => {
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
      const existingPI = resume.personalInfo ? (resume.personalInfo.toObject ? resume.personalInfo.toObject() : resume.personalInfo) : {};
      const pi = { ...existingPI, ...req.body.personalInfo };
      
      // Auto-parse city and country if location string provided
      if (pi.location && typeof pi.location === 'string') {
        const parts = pi.location.split(',').map(s => s.trim());
        if (parts.length > 0 && parts[0] && !pi.city) {
          pi.city = parts[0];
        }
        if (parts.length > 1 && parts[1] && !pi.country) {
          pi.country = parts[1];
        }
      }

      resume.personalInfo = pi;
      resume.markModified('personalInfo');

      if (pi.title) {
        resume.professionalSummary = {
          ...resume.professionalSummary,
          title: pi.title
        };
        resume.markModified('professionalSummary');
      }

      if (pi.location) {
        resume.targetJob = {
          ...resume.targetJob,
          location: pi.location
        };
        resume.markModified('targetJob');
      }
    }

    if (req.body.professionalSummary) {
      resume.professionalSummary = {
        ...resume.professionalSummary,
        ...req.body.professionalSummary
      };
      resume.markModified('professionalSummary');
    }

    if (req.body.targetJob) {
      resume.targetJob = {
        ...resume.targetJob,
        ...req.body.targetJob
      };
      resume.markModified('targetJob');
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

    // 🧠 Fire-and-forget: re-run AI enrichment + invalidate skill gap cache
    setImmediate(() => {
      triggerCareerProfileEnrichment(resume._id.toString(), req.user._id.toString());
      invalidateCacheForResume(resume._id.toString());
    });

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
router.delete('/:id', auth, rejectGuest, async (req, res) => {
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
router.put('/:id/template', auth, rejectGuest, async (req, res) => {
  try {
    const { template } = req.body;
    // Synced with Resume.js model enum — all 13 templates allowed
    const validTemplates = [
      'modern', 'classic', 'creative', 'minimal', 'professional',
      'modern_ats', 'stanford', 'faang', 'jakes', 'rezi', 'flowcv', 'reactive', 'canva'
    ];

    if (!validTemplates.includes(template)) {
      return res.status(400).json({
        success: false,
        error: `Invalid template type. Valid options: ${validTemplates.join(', ')}`
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

    // Use real AI-enriched data where available; never use Math.random()
    const atsScore = resume.careerProfile?.atsScore || null;
    const profileStrength = resume.careerProfile?.profileStrengthScore || null;
    const skillMatchScore = atsScore !== null
      ? atsScore
      : (profileStrength !== null ? Math.min(Math.round(profileStrength), 100) : null);

    const analytics = {
      views: resume.viewCount || 0,
      downloads: resume.downloadCount || 0,
      shares: resume.shareCount || 0,
      // Real application count will require JobApplication model; return null until wired
      applications: null,
      viewHistory: viewHistory,
      // Use AI-computed ATS score; null means not yet analyzed
      skillMatch: skillMatchScore,
      atsScore: atsScore,
      atsKeywords: resume.careerProfile?.atsKeywords?.slice(0, 10) || [],
      profileStrength: profileStrength,
      completeness: resume.completionPercentage || 0,
      strength: resume.isComplete ? 90 : Math.min(50 + (resume.completionPercentage || 0) * 0.5, 85),
      improvements: improvements,
      isEnriched: !!resume.careerProfile?.isEnriched
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

// ========== DEBUG UPLOADED RESUME DATA ==========
router.get('/:id/debug', auth, async (req, res) => {
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

    // Return debugging information
    const debugInfo = {
      resumeId: resume._id,
      fileName: resume.uploadedResume?.fileName,
      uploadDate: resume.uploadedResume?.uploadDate,
      parseError: resume.uploadedResume?.parseError,
      hasPersonalInfo: !!(resume.personalInfo?.firstName || resume.personalInfo?.email),
      personalInfoFields: Object.keys(resume.personalInfo || {}),
      skillsCount: (resume.skills || []).length,
      educationCount: (resume.education || []).length,
      experienceCount: (resume.workExperience || []).length,
      completionPercentage: resume.completionPercentage,
      parsedDataExists: !!(resume.uploadedResume?.parsedData),
      parsedDataKeys: resume.uploadedResume?.parsedData ? Object.keys(resume.uploadedResume.parsedData) : [],
      rawTextLength: resume.uploadedResume?.parsedData?.rawText?.length || 0,
      createdAt: resume.createdAt,
      updatedAt: resume.updatedAt
    };

    res.json({
      success: true,
      data: debugInfo
    });
  } catch (error) {
    console.error('Debug resume error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to get debug info' 
    });
  }
});

// module.exports moved to the end of the file to avoid routing order bugs.
// All routes below (career-profile, primary, tailor, pdf, etc.) are now reachable.

// ==================== CAREER PROFILE INTELLIGENCE ENDPOINTS ====================

// ==================== CAREER PROFILE & ADVANCED ENDPOINTS ====================
// NOTE: These STATIC path routes (/primary, /enhance-text, /suggest-skills) MUST
// be declared BEFORE the parameterized /:id routes to avoid being shadowed.
// They are placed here (after the /:id routes above) but that is acceptable in
// Express because the /:id route above uses regex matching and these are registered
// after. The real fix is that /primary was previously AFTER /:id causing 404s.
// The routing bug is resolved: module.exports is now at the very bottom.

// GET /api/resume/primary - MOVED TO TOP OF FILE TO PREVENT SHADOWING BY /:id
// (Duplicate placeholder removed)

// GET /api/resume/:id/career-profile
// Returns the AI-generated career profile for a specific resume
router.get('/:id/career-profile', auth, async (req, res) => {
  try {
    const resume = await Resume.findOne({ _id: req.params.id, user: req.user._id })
      .select('careerProfile versionTag versionNotes isPrimary personalInfo.firstName personalInfo.lastName updatedAt');

    if (!resume) {
      return res.status(404).json({ success: false, error: 'Resume not found' });
    }

    if (!resume.careerProfile?.isEnriched) {
      return res.status(202).json({
        success: true,
        isEnriched: false,
        message: 'Career profile is being generated. Check back in a few seconds.',
        data: null
      });
    }

    res.json({
      success: true,
      isEnriched: true,
      data: {
        resumeId:         resume._id,
        name:             `${resume.personalInfo?.firstName || ''} ${resume.personalInfo?.lastName || ''}`.trim(),
        versionTag:       resume.versionTag,
        versionNotes:     resume.versionNotes,
        isPrimary:        resume.isPrimary,
        lastAnalyzedAt:   resume.careerProfile.lastAnalyzedAt,
        profileStrength:  resume.careerProfile.profileStrengthScore,
        seniority:        resume.careerProfile.seniority,
        totalYears:       resume.careerProfile.totalYearsExperience,
        extractedSkills:  resume.careerProfile.extractedSkills,
        domainExpertise:  resume.careerProfile.domainExpertise,
        industryBackground: resume.careerProfile.industryBackground,
        preferredRoles:   resume.careerProfile.preferredRoles,
        preferredLocations: resume.careerProfile.preferredLocations,
        openToRemote:     resume.careerProfile.openToRemote,
        openToRelocation: resume.careerProfile.openToRelocation,
        atsKeywords:      resume.careerProfile.atsKeywords,
        strengthAreas:    resume.careerProfile.strengthAreas,
        improvementAreas: resume.careerProfile.improvementAreas
      }
    });
  } catch (err) {
    console.error('Career profile fetch error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/resume/:id/career-profile/refresh
// Manually re-trigger the AI enrichment pipeline for a resume
router.post('/:id/career-profile/refresh', auth, rejectGuest, async (req, res) => {
  try {
    const resume = await Resume.findOne({ _id: req.params.id, user: req.user._id }).select('_id');
    if (!resume) {
      return res.status(404).json({ success: false, error: 'Resume not found' });
    }

    // Immediately respond — enrichment happens async
    res.json({
      success: true,
      message: 'Career profile refresh triggered. It will be ready in a few seconds.'
    });

    // Run enrichment after response is sent
    setImmediate(() => triggerCareerProfileEnrichment(
      resume._id.toString(),
      req.user._id.toString()
    ));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/resume/:id/version-tag
// Update version tag and isPrimary flags (no AI needed — pure data)
router.patch('/:id/version-tag', auth, rejectGuest, async (req, res) => {
  try {
    const { versionTag, versionNotes, isPrimary } = req.body;
    const validTags = ['General', 'Backend', 'Frontend', 'AI/ML', 'Data Science',
                       'DevOps', 'Mobile', 'Cybersecurity', 'Design', 'Management'];

    if (versionTag && !validTags.includes(versionTag)) {
      return res.status(400).json({ success: false, error: 'Invalid version tag' });
    }

    const updates = {};
    if (versionTag  !== undefined) updates.versionTag   = versionTag;
    if (versionNotes !== undefined) updates.versionNotes = versionNotes;
    if (isPrimary    !== undefined) updates.isPrimary    = isPrimary;

    // If setting this resume as primary, unset all others for this user
    if (isPrimary === true) {
      await Resume.updateMany(
        { user: req.user._id, _id: { $ne: req.params.id } },
        { $set: { isPrimary: false } },
        { runValidators: false }
      );
    }

    const resume = await Resume.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $set: updates },
      { new: true, runValidators: true }
    ).select('_id versionTag versionNotes isPrimary updatedAt');

    if (!resume) {
      return res.status(404).json({ success: false, error: 'Resume not found' });
    }

    res.json({ success: true, data: resume, message: 'Version tag updated' });
  } catch (err) {
    console.error('Version tag update error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ========== DUPLICATE RESUME ==========
// POST /api/resume/:id/duplicate
// Duplicates an existing resume (creates a copy with "Copy of [FirstName]")
router.post('/:id/duplicate', auth, rejectGuest, checkResumeLimit, async (req, res) => {
  try {
    const original = await Resume.findOne({ _id: req.params.id, user: req.user._id });
    if (!original) {
      return res.status(404).json({ success: false, error: 'Resume not found' });
    }

    const dupData = original.toObject();
    delete dupData._id;
    delete dupData.createdAt;
    delete dupData.updatedAt;
    
    if (dupData.personalInfo) {
      dupData.personalInfo.firstName = `Copy of ${dupData.personalInfo.firstName || 'Resume'}`;
    }
    dupData.isPrimary = false;

    const duplicate = new Resume(dupData);
    await duplicate.save();

    // Increment lifetime creation count for user
    await User.findByIdAndUpdate(req.user._id, { $inc: { resumeCreationCount: 1 } });

    // Trigger AI career profile enrichment for the copy too
    setImmediate(() => triggerCareerProfileEnrichment(
      duplicate._id.toString(),
      req.user._id.toString()
    ));

    res.status(201).json({
      success: true,
      message: 'Resume duplicated successfully',
      data: duplicate
    });
  } catch (error) {
    console.error('Duplicate resume error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to duplicate resume' });
  }
});

// ========== TAILOR RESUME (AI DRIVEN) ==========
// POST /api/resume/:id/tailor
// Duplicates the source resume, tailors it to target job requirements using GPT-4o-mini,
// saves it as a new version draft, and triggers asynchronous career intelligence enrichment.
router.post('/:id/tailor', auth, rejectGuest, checkResumeLimit, async (req, res) => {
  try {
    const { jobId, jobDescription } = req.body;
    if (!jobId && !jobDescription) {
      return res.status(400).json({
        success: false,
        error: 'Either jobId or jobDescription is required in request body'
      });
    }

    // Call resume tailoring service to generate a new resume document
    const tailoredResume = await tailorResume(req.params.id, req.user._id.toString(), {
      jobId,
      jobDescription
    });

    // Trigger enrichment pipeline for the new resume (generate career profile & skills vector)
    setImmediate(() => triggerCareerProfileEnrichment(
      tailoredResume._id.toString(),
      req.user._id.toString()
    ));

    res.status(201).json({
      success: true,
      message: 'Resume tailored and saved as new version draft successfully',
      data: tailoredResume
    });
  } catch (error) {
    console.error('❌ Tailor resume error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to tailor resume'
    });
  }
});

// ========== DOWNLOAD/STREAM PDF ==========
// GET /api/resume/:id/pdf
// Renders the resume as a styled PDF using PDFKit and streams the response directly.
router.get('/:id/pdf', auth, async (req, res) => {
  try {
    const resume = await Resume.findOne({ _id: req.params.id, user: req.user._id });
    if (!resume) {
      return res.status(404).json({ success: false, error: 'Resume not found' });
    }

    // Track download
    await resume.trackDownload();

    const filename = `${resume.personalInfo?.firstName || 'resume'}_${resume.versionTag || 'version'}.pdf`.toLowerCase().replace(/\s+/g, '_');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    generateResumePDF(resume, res);
  } catch (error) {
    console.error('❌ Export PDF error:', error);
    // Only send error json if headers haven't been sent yet
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to export PDF'
      });
    }
  }
});

// ========== CHECK RESUME COMPATIBILITY / FIT ==========
// POST /api/resume/:id/check-fit
// Checks resume matching criteria against a job/internship using skillGapService.
router.post('/:id/check-fit', auth, async (req, res) => {
  try {
    const { jobId } = req.body;
    if (!jobId) {
      return res.status(400).json({
        success: false,
        error: 'jobId is required'
      });
    }

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

    const { validateApplication } = require('../services/skillGapService');
    const result = await validateApplication(req.params.id, jobId);

    // Meets requirements if verdict is 'apply' or 'apply_with_prep'
    const meetsRequirements = result.verdict === 'apply' || result.verdict === 'apply_with_prep';

    res.json({
      success: true,
      meetsRequirements,
      verdict: result.verdict,
      matchScore: result.matchScore,
      missingSkills: (result.criticalGaps || []).map(g => g.skill),
      message: result.message
    });
  } catch (error) {
    console.error('❌ Check fit error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to check resume compatibility'
    });
  }
});

// ========== OPTIMIZE RESUME (FLOW C - INSTANT AI MATCH) ==========
// POST /api/resume/:id/optimize
// Optimizes and tailors an existing parsed resume for a target job role & template.
router.post('/:id/optimize', auth, rejectGuest, checkResumeLimit, async (req, res) => {
  try {
    const { jobTitle, jobDescription, jobId, template, industry, jobType } = req.body;
    if (!jobTitle) {
      return res.status(400).json({
        success: false,
        error: 'jobTitle is required for optimization target'
      });
    }

    // Prepare targetInfo for the tailoring service
    const targetInfo = {
      jobId,
      jobDescription: jobDescription || `Role target: ${jobTitle}`
    };

    // Tailor the resume (AI optimization step with strict truthfulness prompt)
    const tailoredResume = await tailorResume(req.params.id, req.user._id.toString(), targetInfo);

    // Apply template and target job information to the tailored draft
    if (template) {
      tailoredResume.template = template;
    }
    
    tailoredResume.targetJob = {
      jobTitle: jobTitle,
      industry: industry || '',
      jobType: jobType || 'Full-time'
    };

    await tailoredResume.save();

    // Trigger profile enrichment pipeline in the background
    setImmediate(() => triggerCareerProfileEnrichment(
      tailoredResume._id.toString(),
      req.user._id.toString()
    ));

    res.status(201).json({
      success: true,
      message: 'Resume optimized and tailored for target role successfully',
      data: tailoredResume
    });
  } catch (error) {
    console.error('❌ Optimize resume error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to optimize resume'
    });
  }
});

// POST /api/resume/enhance-text and /suggest-skills - MOVED TO TOP OF FILE TO PREVENT SHADOWING
// (Duplicate placeholders removed)

// ========== AI RESUME INTELLIGENCE ENGINE - FULL OPTIMIZATION ==========
// POST /api/resume/:id/ai-optimize
// Implements the MASTER PROMPT requirements for world-class AI resume optimization
router.post('/:id/ai-optimize', auth, rejectGuest, async (req, res) => {
  try {
    const resume = await Resume.findOne({ _id: req.params.id, user: req.user._id });
    if (!resume) {
      return res.status(404).json({ success: false, error: 'Resume not found' });
    }

    console.log('🧠 AI Resume Intelligence Engine: Starting comprehensive optimization...');

    // Create structured resume data for AI processing
    const resumeForAI = {
      personalInfo: resume.personalInfo || {},
      professionalSummary: resume.professionalSummary || {},
      workExperience: resume.workExperience || [],
      education: resume.education || [],
      skills: resume.skills || [],
      projects: resume.projects || [],
      certifications: resume.certifications || [],
      languages: resume.languages || [],
      targetJob: resume.targetJob || {},
      targetJobs: resume.targetJobs || []
    };

    // Run the Master AI Resume Intelligence Engine
    const { optimizeParsedResume } = require('../services/resumeIntelligenceService');
    const optimizedData = await optimizeParsedResume(resumeForAI);

    // Update resume with AI-optimized content
    resume.careerLevel = optimizedData.careerLevel || resume.careerLevel;
    resume.industry = optimizedData.industry || resume.industry;
    resume.targetRole = optimizedData.targetRole || resume.targetRole;
    resume.professionalBrand = optimizedData.professionalBrand || resume.professionalBrand;
    
    resume.personalBranding = {
      ...(resume.personalBranding || {}),
      ...(optimizedData.personalBranding || {})
    };
    
    resume.careerHighlights = optimizedData.careerHighlights || resume.careerHighlights || [];
    resume.coreCompetencies = optimizedData.coreCompetencies || resume.coreCompetencies || [];
    resume.atsKeywords = optimizedData.atsKeywords || resume.atsKeywords || [];
    resume.missingKeywords = optimizedData.missingKeywords || resume.missingKeywords || [];
    resume.keywordMatchPercentage = optimizedData.keywordMatchPercentage || resume.keywordMatchPercentage || 0;
    
    resume.resumeScores = {
      ...(resume.resumeScores || {}),
      ...(optimizedData.resumeScores || {})
    };
    
    resume.hrScorecard = {
      ...(resume.hrScorecard || {}),
      ...(optimizedData.hrScorecard || {})
    };
    
    resume.hiringDecision = {
      ...(resume.hiringDecision || {}),
      ...(optimizedData.hiringDecision || {})
    };
    
    resume.industryBenchmarking = {
      ...(resume.industryBenchmarking || {}),
      ...(optimizedData.industryBenchmarking || {})
    };
    
    resume.prioritizedImprovementPlan = optimizedData.prioritizedImprovementPlan || resume.prioritizedImprovementPlan || [];
    resume.missingSkills = optimizedData.missingSkills || resume.missingSkills || [];
    resume.strengths = optimizedData.strengths || resume.strengths || [];
    resume.weaknesses = optimizedData.weaknesses || resume.weaknesses || [];
    
    // Store AI-optimized versions
    resume.optimizedSummary = optimizedData.optimizedSummary || resume.optimizedSummary;
    resume.optimizedExperience = optimizedData.optimizedExperience || resume.optimizedExperience;
    resume.optimizedProjects = optimizedData.optimizedProjects || resume.optimizedProjects;
    resume.optimizedSkills = optimizedData.optimizedSkills || resume.optimizedSkills;
    resume.hrRecommendations = optimizedData.hrRecommendations || resume.hrRecommendations || [];

    await resume.save();

    console.log('✅ AI Resume Intelligence Engine: Optimization completed successfully');

    res.json({
      success: true,
      data: {
        careerLevel: resume.careerLevel,
        industry: resume.industry,
        targetRole: resume.targetRole,
        professionalBrand: resume.professionalBrand,
        personalBranding: resume.personalBranding,
        careerHighlights: resume.careerHighlights,
        coreCompetencies: resume.coreCompetencies,
        atsKeywords: resume.atsKeywords,
        missingKeywords: resume.missingKeywords,
        keywordMatchPercentage: resume.keywordMatchPercentage,
        resumeScores: resume.resumeScores,
        hrScorecard: resume.hrScorecard,
        hiringDecision: resume.hiringDecision,
        industryBenchmarking: resume.industryBenchmarking,
        prioritizedImprovementPlan: resume.prioritizedImprovementPlan,
        missingSkills: resume.missingSkills,
        strengths: resume.strengths,
        weaknesses: resume.weaknesses,
        optimizedSummary: resume.optimizedSummary,
        optimizedExperience: resume.optimizedExperience,
        optimizedProjects: resume.optimizedProjects,
        optimizedSkills: resume.optimizedSkills,
        hrRecommendations: resume.hrRecommendations,
        hasOptimizations: !!(resume.optimizedSummary || resume.optimizedExperience || resume.optimizedSkills)
      },
      message: 'Resume optimized using AI Resume Intelligence Engine'
    });
  } catch (error) {
    console.error('❌ AI Resume Intelligence Engine error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to optimize resume with AI' 
    });
  }
});

// ========== AI-ENHANCED PDF GENERATION ==========
// GET /api/resume/:id/ai-pdf
// Generates a Fortune 500-level PDF using AI-optimized content
router.get('/:id/ai-pdf', auth, async (req, res) => {
  try {
    const resume = await Resume.findOne({ _id: req.params.id, user: req.user._id });
    if (!resume) {
      return res.status(404).json({ success: false, error: 'Resume not found' });
    }

    // Check if resume has AI optimizations
    const hasOptimizations = !!(resume.optimizedSummary || resume.optimizedExperience || resume.optimizedSkills);
    
    if (!hasOptimizations) {
      // If no AI optimizations exist, run them first
      console.log('🧠 No AI optimizations found. Running AI Intelligence Engine first...');
      
      const resumeForAI = {
        personalInfo: resume.personalInfo || {},
        professionalSummary: resume.professionalSummary || {},
        workExperience: resume.workExperience || [],
        education: resume.education || [],
        skills: resume.skills || [],
        projects: resume.projects || [],
        certifications: resume.certifications || [],
        languages: resume.languages || [],
        targetJob: resume.targetJob || {},
        targetJobs: resume.targetJobs || []
      };

      const { optimizeParsedResume } = require('../services/resumeIntelligenceService');
      const optimizedData = await optimizeParsedResume(resumeForAI);

      // Update resume with AI-optimized content
      resume.optimizedSummary = optimizedData.optimizedSummary || resume.professionalSummary?.summary;
      resume.optimizedExperience = optimizedData.optimizedExperience || resume.workExperience;
      resume.optimizedProjects = optimizedData.optimizedProjects || resume.projects;
      resume.optimizedSkills = optimizedData.optimizedSkills || resume.skills;
      resume.personalBranding = optimizedData.personalBranding || {};
      resume.coreCompetencies = optimizedData.coreCompetencies || [];
      
      await resume.save();
      console.log('✅ AI optimizations applied and saved');
    }

    // Track download
    await resume.trackDownload();

    // Generate AI-enhanced filename
    const firstName = resume.personalInfo?.firstName || 'Professional';
    const targetRole = resume.targetRole || resume.professionalSummary?.title || 'Candidate';
    const cleanTargetRole = targetRole.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `${firstName}_${cleanTargetRole}_AI_Enhanced_Resume.pdf`.toLowerCase();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-AI-Enhanced', 'true');
    res.setHeader('X-Resume-Version', resume.versionTag || 'General');

    // Generate the AI-enhanced PDF
    generateResumePDF(resume, res);

  } catch (error) {
    console.error('❌ AI-Enhanced PDF generation error:', error);
    
    // Only send error json if headers haven't been sent yet
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to generate AI-enhanced PDF'
      });
    }
  }
});

module.exports = router;