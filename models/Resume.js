// models/Resume.js
const mongoose = require('mongoose');

const resumeSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  personalInfo: {
    firstName: { type: String, default: '' },
    lastName: { type: String, default: '' },
    email: { type: String, default: '' },
    phone: { type: String, default: '' },
    address: { type: String, default: '' },
    city: { type: String, default: '' },
    state: { type: String, default: '' },
    country: { type: String, default: '' },
    postalCode: { type: String, default: '' },
    linkedin: { type: String, default: '' },
    github: { type: String, default: '' },
    portfolio: { type: String, default: '' }
  },
  professionalSummary: {
    title: { type: String, default: '' },
    summary: { type: String, default: '' },
    experienceLevel: {
      type: String,
      default: 'Mid Level'
    }
  },
  education: [{
    institution: { type: String, default: '' },
    degree: { type: String, default: '' },
    fieldOfStudy: { type: String, default: '' },
    startDate: { type: Date },
    endDate: { type: Date },
    current: { type: Boolean, default: false },
    gpa: { type: Number },
    description: { type: String, default: '' }
  }],
  skills: [{
    name: { type: String, default: '' },
    level: {
      type: String,
      default: 'Intermediate'
    },
    category: {
      type: String,
      default: 'Technical'
    }
  }],
  workExperience: [{
    company: { type: String, default: '' },
    position: { type: String, default: '' },
    location: { type: String, default: '' },
    startDate: { type: Date },
    endDate: { type: Date },
    current: { type: Boolean, default: false },
    description: { type: String, default: '' },
    achievements: [String],
    companyWebsite: { type: String, default: '' }
  }],
  certifications: [{
    name: { type: String, default: '' },
    organization: { type: String, default: '' },
    issueDate: { type: Date },
    expiryDate: { type: Date },
    credentialId: { type: String, default: '' },
    credentialUrl: { type: String, default: '' }
  }],
  projects: [{
    name: { type: String, default: '' },
    description: { type: String, default: '' },
    technologies: [String],
    startDate: { type: Date },
    endDate: { type: Date },
    url: { type: String, default: '' },
    githubUrl: { type: String, default: '' }
  }],
  languages: [{
    name: { type: String, default: '' },
    proficiency: {
      type: String,
      default: 'Intermediate'
    }
  }],
  interests: [String],
  references: [{
    name: { type: String, default: '' },
    position: { type: String, default: '' },
    company: { type: String, default: '' },
    email: { type: String, default: '' },
    phone: { type: String, default: '' }
  }],
  targetJobs: [{
    jobTitle: { type: String, default: '' },
    industry: { type: String, default: '' },
    jobType: {
      type: String,
      enum: ['Full-time', 'Part-time', 'Contract', 'Internship', 'Remote'],
      default: 'Full-time'
    },
    desiredSalary: { type: String, default: '' },
    location: { type: String, default: '' },
    availability: { type: String, default: '' }
  }],
  targetJob: {
    jobTitle: { type: String, default: '' },
    industry: { type: String, default: '' },
    jobType: {
      type: String,
      enum: ['Full-time', 'Part-time', 'Contract', 'Internship', 'Remote'],
      default: 'Full-time'
    },
    desiredSalary: { type: String, default: '' },
    location: { type: String, default: '' },
    availability: { type: String, default: '' }
  },
  template: {
    type: String,
    enum: ['modern', 'classic', 'creative', 'minimal', 'professional', 'modern_ats', 'stanford', 'faang', 'jakes', 'rezi', 'flowcv', 'reactive', 'canva'],
    default: 'modern_ats'
  },
  customStyles: {
    font: { type: String, default: 'Inter' },
    accentColor: { type: String, default: '#1E3A8A' },
    headingColor: { type: String, default: '#0F172A' },
    textColor: { type: String, default: '#334155' },
    bgColor: { type: String, default: '#FFFFFF' }
  },

  // ==================== CAREER INTELLIGENCE LAYER ====================
  // Populated automatically after each resume save via careerProfileService.
  // Never written directly by the frontend — always AI-generated.
  careerProfile: {
    // AI-extracted skill taxonomy
    extractedSkills: {
      technical: { type: [String], default: [] },
      frameworks: { type: [String], default: [] },
      languages: { type: [String], default: [] },
      softSkills: { type: [String], default: [] },
      tools: { type: [String], default: [] },
      databases: { type: [String], default: [] },
      cloud: { type: [String], default: [] }
    },
    // Domain intelligence
    domainExpertise: { type: [String], default: [] },
    seniority: { type: String, default: '' },
    totalYearsExperience: { type: Number, default: 0 },
    industryBackground: { type: [String], default: [] },
    // Career intent (normalised from targetJobs)
    preferredRoles: { type: [String], default: [] },
    preferredIndustries: { type: [String], default: [] },
    preferredLocations: { type: [String], default: [] },
    preferredSalaryMin: { type: Number, default: 0 },
    preferredSalaryMax: { type: Number, default: 0 },
    openToRemote: { type: Boolean, default: false },
    openToRelocation: { type: Boolean, default: false },
    // ATS intelligence
    atsKeywords: { type: [String], default: [] },
    atsScore: { type: Number, default: 0 },
    // Strengths & improvement areas
    strengthAreas: { type: [String], default: [] },
    improvementAreas: { type: [String], default: [] },
    // Semantic embedding for vector similarity search
    embedding: {
      vector: { type: [Number], select: false },  // 1536-dim; never returned in default queries
      model: { type: String, default: 'text-embedding-3-small' },
      generatedAt: { type: Date },
      version: { type: Number, default: 1 }
    },
    // Pipeline metadata
    lastAnalyzedAt: { type: Date },
    analysisVersion: { type: String, default: '1.0.0' },
    profileStrengthScore: { type: Number, default: 0 },
    isEnriched: { type: Boolean, default: false }  // true once AI pipeline has run
  },

  // ==================== RESUME VERSION INTELLIGENCE ====================
  versionTag: {
    type: String,
    enum: ['General', 'Backend', 'Frontend', 'AI/ML', 'Data Science',
      'DevOps', 'Mobile', 'Cybersecurity', 'Design', 'Management'],
    default: 'General'
  },
  versionNotes: { type: String, default: '' },
  isPrimary: { type: Boolean, default: false },
  uploadedResume: {
    fileName: { type: String, default: '' },
    fileUrl: { type: String, default: '' },
    publicId: { type: String, default: '' },
    uploadDate: { type: Date },
    parsedData: { type: mongoose.Schema.Types.Mixed }
  },
  settings: {
    visibility: { type: String, enum: ['public', 'private', 'unlisted'], default: 'public' },
    allowDownload: { type: Boolean, default: true },
    allowSharing: { type: Boolean, default: true },
    showContactInfo: { type: Boolean, default: true },
    showSocialLinks: { type: Boolean, default: true },
    showSkills: { type: Boolean, default: true },
    showExperience: { type: Boolean, default: true },
    showEducation: { type: Boolean, default: true },
    showCertifications: { type: Boolean, default: true },
    showProjects: { type: Boolean, default: true },
    showLanguages: { type: Boolean, default: true },
    showInterests: { type: Boolean, default: true },
    showReferences: { type: Boolean, default: true },
    fontSize: { type: String, enum: ['small', 'medium', 'large'], default: 'medium' },
    colorScheme: { type: String, enum: ['blue', 'green', 'purple', 'red', 'orange'], default: 'blue' },
    language: { type: String, default: 'en' },
    autoSave: { type: Boolean, default: true },
    saveInterval: { type: Number, default: 30 },
    defaultTemplate: { type: String, default: 'modern' }
  },
  completionPercentage: { type: Number, default: 0 },
  isComplete: { type: Boolean, default: false },
  sharedWith: [{
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    sharedAt: { type: Date, default: Date.now }
  }],
  viewCount: { type: Number, default: 0 },
  downloadCount: { type: Number, default: 0 },
  shareCount: { type: Number, default: 0 },
  viewsHistory: [{
    date: { type: Date, default: Date.now },
    count: { type: Number, default: 1 }
  }],
  careerLevel: { type: String, default: '' },
  industry: { type: String, default: '' },
  targetRole: { type: String, default: '' },
  professionalBrand: { type: String, default: '' },
  personalBranding: {
    professionalHeadline: { type: String, default: '' },
    personalBrandStatement: { type: String, default: '' },
    coreValueProposition: { type: String, default: '' },
    professionalIdentity: { type: String, default: '' }
  },
  careerHighlights: { type: [String], default: [] },
  coreCompetencies: { type: [String], default: [] },
  atsKeywords: { type: [String], default: [] },
  missingKeywords: { type: [String], default: [] },
  keywordMatchPercentage: { type: Number, default: 0 },
  resumeScores: {
    atsScore: { type: Number, default: 0 },
    recruiterScore: { type: Number, default: 0 },
    contentQuality: { type: Number, default: 0 },
    keywordStrength: { type: Number, default: 0 },
    formattingScore: { type: Number, default: 0 },
    impactScore: { type: Number, default: 0 },
    overallHiringScore: { type: Number, default: 0 }
  },
  hrScorecard: {
    professionalSummaryScore: { type: Number, default: 0 },
    experienceScore: { type: Number, default: 0 },
    projectsScore: { type: Number, default: 0 },
    educationScore: { type: Number, default: 0 },
    skillsScore: { type: Number, default: 0 },
    achievementsScore: { type: Number, default: 0 },
    atsScore: { type: Number, default: 0 },
    formattingScore: { type: Number, default: 0 },
    professionalBrandingScore: { type: Number, default: 0 },
    overallScore: { type: Number, default: 0 }
  },
  hiringDecision: {
    hrShortlist: {
      status: { type: String, default: '' },
      reason: { type: String, default: '' }
    },
    hiringManagerInterview: {
      status: { type: String, default: '' },
      reason: { type: String, default: '' }
    },
    departmentHeadApprove: {
      status: { type: String, default: '' },
      reason: { type: String, default: '' }
    }
  },
  industryBenchmarking: {
    percentileRank: { type: String, default: '' },
    rankExplanation: { type: String, default: '' }
  },
  prioritizedImprovementPlan: [{
    priority: { type: String, default: '' },
    recommendation: { type: String, default: '' },
    why: { type: String, default: '' },
    impact: {
      business: { type: String, default: '' },
      hr: { type: String, default: '' },
      ats: { type: String, default: '' },
      hiring: { type: String, default: '' }
    }
  }],
  missingSkills: { type: [String], default: [] },
  strengths: { type: [String], default: [] },
  weaknesses: { type: [String], default: [] },
  optimizedSummary: { type: String, default: '' },
  optimizedExperience: { type: mongoose.Schema.Types.Mixed },
  optimizedProjects: { type: mongoose.Schema.Types.Mixed },
  optimizedSkills: { type: mongoose.Schema.Types.Mixed },
  hrRecommendations: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, {
  strict: true,
  minimize: false
});

// Indexes
resumeSchema.index({ user: 1 });
resumeSchema.index({ 'targetJob.jobTitle': 1 });
resumeSchema.index({ createdAt: -1 });

// Pre-save middleware
resumeSchema.pre('save', function () {
  this.updatedAt = new Date();
  try {
    this.completionPercentage = this.calculateCompletionPercentage();
    this.isComplete = this.completionPercentage >= 85;
  } catch (error) {
    console.error('Error calculating completion:', error);
  }
});

// Calculate completion percentage
resumeSchema.methods.calculateCompletionPercentage = function () {
  try {
    let total = 0;
    let completed = 0;

    // Personal Info (15%)
    if (this.personalInfo) {
      const hasName = this.personalInfo.firstName && this.personalInfo.firstName.trim() !== '';
      const hasEmail = this.personalInfo.email && this.personalInfo.email.trim() !== '';
      const hasPhone = this.personalInfo.phone && this.personalInfo.phone.trim() !== '';
      if (hasName) completed += 5;
      if (hasEmail) completed += 5;
      if (hasPhone) completed += 5;
      total += 15;
    }

    // Professional Summary (10%)
    if (this.professionalSummary && this.professionalSummary.summary && this.professionalSummary.summary.trim() !== '') {
      completed += 10;
    }
    total += 10;

    // Education (15%)
    if (this.education && this.education.length > 0) {
      const validEducation = this.education.filter(e => e.institution && e.institution.trim() !== '');
      if (validEducation.length > 0) {
        completed += Math.min(15, validEducation.length * 5);
      }
    }
    total += 15;

    // Skills (10%)
    if (this.skills && this.skills.length > 0) {
      const validSkills = this.skills.filter(s => s.name && s.name.trim() !== '');
      if (validSkills.length > 0) {
        completed += Math.min(10, validSkills.length * 2);
      }
    }
    total += 10;

    // Work Experience (20%)
    if (this.workExperience && this.workExperience.length > 0) {
      const validExperience = this.workExperience.filter(w => w.company && w.company.trim() !== '');
      if (validExperience.length > 0) {
        completed += Math.min(20, validExperience.length * 5);
      }
    }
    total += 20;

    // Certifications (5%)
    if (this.certifications && this.certifications.length > 0) {
      const validCerts = this.certifications.filter(c => c.name && c.name.trim() !== '');
      if (validCerts.length > 0) {
        completed += Math.min(5, validCerts.length * 2);
      }
    }
    total += 5;

    // Projects (5%)
    if (this.projects && this.projects.length > 0) {
      const validProjects = this.projects.filter(p => p.name && p.name.trim() !== '');
      if (validProjects.length > 0) {
        completed += Math.min(5, validProjects.length * 2);
      }
    }
    total += 5;

    // Languages (5%)
    if (this.languages && this.languages.length > 0) {
      const validLanguages = this.languages.filter(l => l.name && l.name.trim() !== '');
      if (validLanguages.length > 0) {
        completed += Math.min(5, validLanguages.length * 2);
      }
    }
    total += 5;

    // Target Jobs (15%)
    if (this.targetJobs && this.targetJobs.length > 0) {
      const validJobs = this.targetJobs.filter(j => j.jobTitle && j.jobTitle.trim() !== '');
      if (validJobs.length > 0) {
        completed += Math.min(15, validJobs.length * 5);
      }
    } else if (this.targetJob && this.targetJob.jobTitle && this.targetJob.jobTitle.trim() !== '') {
      completed += 15;
    }
    total += 15;

    return Math.min(Math.round((completed / total) * 100), 100);
  } catch (error) {
    console.error('Error calculating completion:', error);
    return 0;
  }
};

// ============ METHODS FOR JOB RECOMMENDATIONS ============

// Extract all skills from resume
resumeSchema.methods.extractAllSkills = function () {
  const skillSet = new Set();

  // 1. Add skills from skills array
  if (this.skills && this.skills.length > 0) {
    this.skills.forEach(skill => {
      if (skill.name && skill.name.trim()) {
        skillSet.add(skill.name.toLowerCase().trim());
      }
    });
  }

  // 2. Extract skills from work experience descriptions
  if (this.workExperience && this.workExperience.length > 0) {
    this.workExperience.forEach(work => {
      if (work.description) {
        const words = work.description.split(/[\s,.;:!?()]+/);
        const techKeywords = ['javascript', 'react', 'node', 'python', 'java', 'c++', 'typescript',
          'angular', 'vue', 'mongodb', 'mysql', 'postgresql', 'docker', 'kubernetes', 'aws',
          'git', 'github', 'html', 'css', 'php', 'laravel', 'mern', 'fullstack', 'frontend',
          'backend', 'api', 'rest', 'graphql', 'tensorflow', 'pytorch', 'machine', 'learning',
          'ai', 'data', 'analytics', 'tableau', 'powerbi', 'flask', 'django', 'spring', 'csharp',
          'ruby', 'rails', 'swift', 'kotlin', 'flutter', 'reactnative', 'sqlite', 'firebase',
          'redis', 'elasticsearch', 'kafka', 'jenkins', 'ansible', 'terraform', 'prometheus',
          'grafana', 'linux', 'unix', 'bash', 'shell', 'vim', 'vscode', 'intellij'];

        words.forEach(word => {
          const cleanWord = word.toLowerCase().replace(/[^a-zA-Z0-9#\+\-]/g, '');
          if (cleanWord.length > 2 && techKeywords.some(tk => cleanWord.includes(tk))) {
            skillSet.add(cleanWord);
          }
        });
      }
      // Add position as skill
      if (work.position) {
        const positionWords = work.position.split(' ');
        positionWords.forEach(word => {
          const cleanWord = word.toLowerCase().trim();
          if (cleanWord.length > 2 && ['developer', 'engineer', 'analyst', 'manager', 'director',
            'architect', 'designer', 'consultant', 'specialist', 'lead', 'senior', 'junior'].includes(cleanWord)) {
            skillSet.add(cleanWord);
          }
        });
      }
    });
  }

  // 3. Extract skills from projects
  if (this.projects && this.projects.length > 0) {
    this.projects.forEach(project => {
      if (project.technologies && project.technologies.length > 0) {
        project.technologies.forEach(tech => {
          if (tech && tech.trim()) {
            skillSet.add(tech.toLowerCase().trim());
          }
        });
      }
      if (project.description) {
        const techKeywords = ['react', 'node', 'python', 'javascript', 'mongodb', 'express',
          'docker', 'aws', 'firebase', 'flutter', 'reactnative', 'tensorflow', 'pytorch'];
        const words = project.description.split(/[\s,.;:!?()]+/);
        words.forEach(word => {
          const cleanWord = word.toLowerCase().replace(/[^a-zA-Z0-9#\+\-]/g, '');
          if (cleanWord.length > 2 && techKeywords.some(tk => cleanWord.includes(tk))) {
            skillSet.add(cleanWord);
          }
        });
      }
    });
  }

  // 4. Extract from certifications
  if (this.certifications && this.certifications.length > 0) {
    this.certifications.forEach(cert => {
      if (cert.name) {
        const words = cert.name.split(' ');
        words.forEach(word => {
          const cleanWord = word.toLowerCase().trim();
          if (cleanWord.length > 2) {
            skillSet.add(cleanWord);
          }
        });
      }
    });
  }

  // 5. Extract from education
  if (this.education && this.education.length > 0) {
    this.education.forEach(edu => {
      if (edu.fieldOfStudy) {
        const fields = edu.fieldOfStudy.split(' ');
        fields.forEach(field => {
          const cleanField = field.toLowerCase().trim();
          if (cleanField.length > 2) {
            skillSet.add(cleanField);
          }
        });
      }
    });
  }

  return Array.from(skillSet);
};

// Get experience level
resumeSchema.methods.getExperienceLevel = function () {
  let totalYears = 0;

  if (this.workExperience && this.workExperience.length > 0) {
    this.workExperience.forEach(work => {
      if (work.startDate) {
        const start = new Date(work.startDate);
        const end = work.current ? new Date() : (work.endDate ? new Date(work.endDate) : new Date());
        const years = (end - start) / (365.25 * 24 * 60 * 60 * 1000);
        if (years > 0) {
          totalYears += years;
        }
      }
    });
  }

  if (totalYears <= 2) return 'Entry Level';
  if (totalYears <= 5) return 'Mid Level';
  if (totalYears <= 10) return 'Senior Level';
  return 'Executive';
};

// Get preferred job types
resumeSchema.methods.getPreferredJobTypes = function () {
  const types = new Set();

  if (this.targetJobs && this.targetJobs.length > 0) {
    this.targetJobs.forEach(job => {
      if (job.jobType) {
        types.add(job.jobType);
      }
    });
  }

  if (types.size === 0) {
    types.add('Full-time');
  }

  return Array.from(types);
};

// Get preferred locations
resumeSchema.methods.getPreferredLocations = function () {
  const locations = new Set();

  if (this.targetJobs && this.targetJobs.length > 0) {
    this.targetJobs.forEach(job => {
      if (job.location) {
        locations.add(job.location);
      }
    });
  }

  if (this.personalInfo && this.personalInfo.city) {
    locations.add(this.personalInfo.city);
  }
  if (this.personalInfo && this.personalInfo.state) {
    locations.add(this.personalInfo.state);
  }
  if (this.personalInfo && this.personalInfo.country) {
    locations.add(this.personalInfo.country);
  }

  return Array.from(locations);
};

// Get target job titles
resumeSchema.methods.getTargetTitles = function () {
  const titles = new Set();

  if (this.targetJobs && this.targetJobs.length > 0) {
    this.targetJobs.forEach(job => {
      if (job.jobTitle) {
        titles.add(job.jobTitle.toLowerCase());
      }
    });
  }

  return Array.from(titles);
};

// Get target industries
resumeSchema.methods.getTargetIndustries = function () {
  const industries = new Set();

  if (this.targetJobs && this.targetJobs.length > 0) {
    this.targetJobs.forEach(job => {
      if (job.industry) {
        industries.add(job.industry.toLowerCase());
      }
    });
  }

  return Array.from(industries);
};

// Static method for recommendations
resumeSchema.statics.getRecommendedJobs = async function (resumeId) {
  try {
    const resume = await this.findById(resumeId);
    if (!resume) return [];

    const skills = resume.extractAllSkills();
    const experienceLevel = resume.getExperienceLevel();
    const preferredJobTypes = resume.getPreferredJobTypes();
    const preferredLocations = resume.getPreferredLocations();
    const targetTitles = resume.getTargetTitles();
    const targetIndustries = resume.getTargetIndustries();

    const Job = require('./Job');

    let query = { active: true, type: 'Internship', location: { $regex: 'pakistan|karachi|lahore|islamabad|rawalpindi|faisalabad|multan|peshawar|quetta|sialkot|gujranwala|hyderabad|abbottabad|sargodha|bahawalpur|sukkur|larkana|gujrat|sheikhupura|jhelum|sahiwal|pk', $options: 'i' } };
    let matchConditions = [];

    if (skills.length > 0) {
      skills.slice(0, 15).forEach(skill => {
        matchConditions.push(
          { skills: { $in: [new RegExp(skill, 'i')] } },
          { title: { $regex: skill, $options: 'i' } },
          { description: { $regex: skill, $options: 'i' } },
          { department: { $regex: skill, $options: 'i' } }
        );
      });
    }

    if (targetTitles.length > 0) {
      targetTitles.forEach(title => {
        matchConditions.push({ title: { $regex: title, $options: 'i' } });
      });
    }

    if (targetIndustries.length > 0) {
      targetIndustries.forEach(industry => {
        matchConditions.push({ department: { $regex: industry, $options: 'i' } });
        matchConditions.push({ category: { $regex: industry, $options: 'i' } });
      });
    }

    if (preferredLocations.length > 0) {
      preferredLocations.forEach(loc => {
        matchConditions.push({ location: { $regex: loc, $options: 'i' } });
      });
    }

    if (matchConditions.length > 0) {
      query.$or = matchConditions;
    }

    if (experienceLevel) {
      query.experienceLevel = experienceLevel;
    }

    if (preferredJobTypes.length > 0) {
      const filteredTypes = preferredJobTypes.filter(t => t.toLowerCase() === 'internship');
      if (filteredTypes.length > 0) {
        query.type = { $in: filteredTypes };
      } else {
        query.type = 'Internship';
      }
    } else {
      query.type = 'Internship';
    }

    let jobs = await Job.find(query)
      .sort({ featured: -1, urgent: -1, createdAt: -1 })
      .limit(20);

    // Fallback: if no jobs are found with strict experienceLevel filters, relax them
    if (jobs.length === 0 && query.experienceLevel) {
      const fallbackQuery = { ...query };
      delete fallbackQuery.experienceLevel;
      jobs = await Job.find(fallbackQuery)
        .sort({ featured: -1, urgent: -1, createdAt: -1 })
        .limit(20);
    }

    const recommendations = jobs.map(job => {
      let matchScore = 0;
      let matchedSkills = [];
      let matchReasons = [];

      if (skills.length > 0 && job.skills && job.skills.length > 0) {
        const jobSkills = job.skills.map(s => s.toLowerCase().trim());
        const resumeSkills = skills.map(s => s.toLowerCase().trim());

        jobSkills.forEach(skill => {
          if (resumeSkills.some(rs => skill.includes(rs) || rs.includes(skill))) {
            matchedSkills.push(skill);
            matchScore += 8;
          }
        });
        if (matchedSkills.length > 0) {
          matchReasons.push(`Matched ${matchedSkills.length} skills`);
        }
      }

      if (targetTitles.length > 0) {
        const jobTitle = job.title.toLowerCase();
        let titleMatched = false;
        targetTitles.forEach(title => {
          if (jobTitle.includes(title) || title.includes(jobTitle)) {
            matchScore += 15;
            titleMatched = true;
          }
        });
        if (titleMatched) {
          matchReasons.push('Matches target job title');
        }
      }

      if (job.experienceLevel === experienceLevel) {
        matchScore += 10;
        matchReasons.push(`Experience level: ${experienceLevel}`);
      }

      if (preferredJobTypes.includes(job.type)) {
        matchScore += 10;
        matchReasons.push(`Job type: ${job.type}`);
      }

      if (preferredLocations.length > 0) {
        const jobLocation = (job.location || '').toLowerCase();
        let locationMatched = false;
        preferredLocations.forEach(loc => {
          if (jobLocation.includes(loc.toLowerCase())) {
            matchScore += 10;
            locationMatched = true;
          }
        });
        if (locationMatched) {
          matchReasons.push('Location match');
        }
      }

      if (targetIndustries.length > 0 && job.department) {
        const jobDept = (job.department || '').toLowerCase();
        targetIndustries.forEach(industry => {
          if (jobDept.includes(industry) || industry.includes(jobDept)) {
            matchScore += 10;
            matchReasons.push(`Industry: ${job.department}`);
          }
        });
      }

      if (job.featured) matchScore += 3;
      if (job.urgent) matchScore += 2;

      matchScore = Math.min(matchScore, 100);

      if (matchScore >= 20) {
        return {
          ...job.toObject(),
          matchPercentage: matchScore,
          matchedSkills: matchedSkills.slice(0, 5),
          matchReasons: matchReasons.slice(0, 3),
          isRecommended: matchScore >= 50
        };
      }
      return null;
    }).filter(job => job !== null);

    recommendations.sort((a, b) => b.matchPercentage - a.matchPercentage);

    return recommendations.slice(0, 6);
  } catch (error) {
    console.error('Error getting recommended jobs:', error);
    return [];
  }
};

// Track view
resumeSchema.methods.trackView = async function () {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const result = await this.constructor.updateOne(
    { _id: this._id, 'viewsHistory.date': today },
    { 
      $inc: { viewCount: 1, 'viewsHistory.$.count': 1 } 
    }
  );

  if (result.matchedCount === 0) {
    return this.constructor.updateOne(
      { _id: this._id },
      { 
        $inc: { viewCount: 1 },
        $push: { viewsHistory: { date: today, count: 1 } }
      }
    );
  }
  return result;
};

// Track download
resumeSchema.methods.trackDownload = function () {
  return this.constructor.updateOne(
    { _id: this._id },
    { $inc: { downloadCount: 1 } }
  );
};

const Resume = mongoose.model('Resume', resumeSchema);
module.exports = Resume;