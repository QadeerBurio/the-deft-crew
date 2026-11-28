// models/Resume.js
const mongoose = require('mongoose');
const { resumeStrength, resumeStrengthV2, defaultResumeName } = require('../utils/resumeRules');
const { layoutKey } = require('../utils/resumeRender');

const resumeSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  personalInfo: {
    firstName: { type: String, default: '' },
    lastName: { type: String, default: '' },
    title: { type: String, default: '' },
    email: { type: String, default: '' },
    phone: { type: String, default: '' },
    location: { type: String, default: '' },
    address: { type: String, default: '' },
    city: { type: String, default: '' },
    state: { type: String, default: '' },
    country: { type: String, default: '' },
    postalCode: { type: String, default: '' },
    linkedin: { type: String, default: '' },
    github: { type: String, default: '' },
    portfolio: { type: String, default: '' },
    // P3-6 (optional): a photo for templates that show one, only when the student turns it on (an https link)
    photoUrl: { type: String, default: undefined }
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
    grade: { type: String, default: '' }, // as written ("3.5/4", "A", "First Division")
    description: { type: String, default: '' }
  }],
  skills: [{
    name: { type: String, default: '' },
    // resume full fix: never a level the student didn't give (it was 'Intermediate'); older resumes keep theirs
    level: { type: String, default: '' },
    category: {
      type: String,
      default: 'Technical'
    },
    // resume full fix: the group the student put it in (shown on the resume as "Technical: …"); empty = ungrouped
    group: { type: String, enum: ['', 'technical', 'tools', 'soft'], default: '' }
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
    // resume full fix: only what the student said (it was 'Intermediate', printed as "(Intermediate)")
    proficiency: { type: String, default: '' }
  }],
  interests: [String],
  achievements: [String],
  // P3-3 (additive, all optional): the sections freshers have. activities = societies, clubs, leadership;
  // volunteering has the same shape; awards; relevant coursework (strings). Missing on older resumes = empty.
  activities: [{
    organisation: { type: String, default: '' },
    role: { type: String, default: '' },
    startDate: { type: Date },
    endDate: { type: Date },
    current: { type: Boolean, default: false },
    description: { type: String, default: '' },
    bullets: [String]
  }],
  volunteering: [{
    organisation: { type: String, default: '' },
    role: { type: String, default: '' },
    startDate: { type: Date },
    endDate: { type: Date },
    current: { type: Boolean, default: false },
    description: { type: String, default: '' },
    bullets: [String]
  }],
  awards: [{
    title: { type: String, default: '' },
    issuer: { type: String, default: '' },
    date: { type: Date },
    note: { type: String, default: '' }
  }],
  coursework: [String],
  otherNotes: { type: String, default: '' }, // resume text an upload couldn't place in a section
  // the resume's name: the student's own when nameCustom, else "<Full name> – <title>" (utils/resumeRules)
  name: { type: String, default: '' },
  nameCustom: { type: Boolean, default: false },
  importReport: { type: mongoose.Schema.Types.Mixed }, // what an upload filled in (status per section)
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
    // the older ids + the template studio's (P3-6, config/resumeTemplates.js)
    enum: require('../config/resumeTemplates').TEMPLATE_IDS,
    default: 'modern_ats'
  },
  customStyles: {
    font: { type: String, default: 'Inter' },
    accentColor: { type: String, default: '#1E3A8A' },
    headingColor: { type: String, default: '#0F172A' },
    textColor: { type: String, default: '#334155' },
    bgColor: { type: String, default: '#FFFFFF' },
    // P3-6 template studio (all optional; missing = the template's own look). Checked by
    // config/resumeTemplates.cleanCustomStyles before they are saved.
    palette: { type: String },
    fontPair: { type: String },
    size: { type: String, enum: ['S', 'M', 'L'] },
    density: { type: String, enum: ['compact', 'normal', 'airy'] },
    margins: { type: String, enum: ['narrow', 'normal', 'wide'] },
    headingCase: { type: String, enum: ['upper', 'title'] },
    headingStyle: { type: String, enum: ['rule', 'bar', 'underline', 'none'] },
    headingIcons: { type: Boolean },
    sectionOrder: { type: [String], default: undefined },
    hiddenSections: { type: [String], default: undefined },
    headings: { type: mongoose.Schema.Types.Mixed },
    photo: { on: { type: Boolean }, shape: { type: String, enum: ['circle', 'rounded', 'square'] } },
    dateFormat: { type: String, enum: ['mon-yyyy', 'mm/yyyy'] },
    pageSize: { type: String, enum: ['A4', 'Letter'] },
    linkStyle: { type: String, enum: ['full', 'short'] }
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
    defaultTemplate: { type: String, default: 'modern' },
    // P3-1 / P3-2: "fresher" (no internship or job yet) or "experienced"; missing = experienced (old resumes unchanged)
    track: { type: String, enum: ['fresher', 'experienced'] },
    // P3d: the "verified by tdc" line on this resume (facts from the server, never typed); off until the student adds it
    verifiedLine: { type: Boolean, default: false },
    // resume full fix (resumeV2): gate = this resume was made or edited with the gap check, so "next" / "finish" wait for
    // the minimums (older finished resumes: advice only). waived = "I really don't have this" (experience, projects,
    // education_extra): the item counts once a fresher alternative is added, never by the waiver alone.
    gate: { type: Boolean, default: undefined },
    waived: { type: [String], default: undefined }
  },
  // resume full fix: the page as the app measured it on the real render (preview WebView): fill 1 = one full page.
  // key = utils/resumeRender layoutKey of the render it measured; a different key (content or template changed) = stale.
  layout: {
    key: { type: String },
    fill: { type: Number, min: 0, max: 10 },
    pages: { type: Number, min: 1, max: 20 },
    template: { type: String },
    at: { type: Date }
  },
  // resume full fix: "resume strength" v2 (content depth + page fill, utils/resumeRules resumeStrengthV2). The app shows it
  // with resumeV2 on; completionPercentage stays the old score for older apps.
  strength: { type: Number, default: 0 },
  // P3d public resume page (owner #1): off until the student turns it on; its own switch (never settings.visibility).
  // slug: the unguessable link (22 random characters, a new one on "new link"); selfKey: added to the student's own
  // "open my page" so their visits aren't counted. Both are never sent with the resume (select: false).
  publicPage: {
    on: { type: Boolean, default: false },
    slug: { type: String, select: false, index: { unique: true, sparse: true } },
    selfKey: { type: String, select: false },
    showPhone: { type: Boolean, default: false },
    showEmail: { type: Boolean, default: false },
    views: { type: Number, default: 0 },
    updatedAt: { type: Date },
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
    // "resume strength": the same calculation the app shows (utils/resumeRules)
    this.completionPercentage = resumeStrength(this).score;
    this.isComplete = this.completionPercentage >= 85;
    this.strength = strengthNow(this).score;
    if (!this.nameCustom || !String(this.name || '').trim()) { this.nameCustom = false; this.name = defaultResumeName(this); }
  } catch (error) {
    console.error('Error calculating completion:', error);
  }
});

// resume full fix: strength v2 of a resume document, with the stored page measurement only while it matches the
// resume as it is now (same render key)
function strengthNow(doc) {
  const plain = JSON.parse(JSON.stringify(typeof doc.toObject === 'function' ? doc.toObject({ depopulate: true }) : doc));
  const l = plain.layout || {};
  let page = null;
  try { if (l.key && typeof l.fill === 'number' && l.key === layoutKey(plain, plain.template, plain.customStyles || {})) page = { fill: l.fill, pages: l.pages || 1 }; } catch (e) { page = null; }
  return resumeStrengthV2(plain, page);
}
resumeSchema.statics.strengthNow = strengthNow;
resumeSchema.methods.strengthReport = function () { return strengthNow(this); };

// (resume full fix) the old field-count calculateCompletionPercentage was removed: nothing called it; completionPercentage
// is utils/resumeRules resumeStrength (pre-save above).

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
// TODO(after the career matching pilot): remove. Matches on location and free-text regexes; students with
// FLAG_CAREER_MATCHING already get services/career/recommendations.js. Caller left (students outside the pilot):
//   routes/resume.routes.js  GET /api/resume/:id/recommendations
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

// Pre-save hook to strictly enforce maximum 2 lifetime resume creations per user (race-condition protection)
resumeSchema.pre('save', async function () {
  if (this.isNew && this.user) {
    const User = mongoose.model('User');
    const userDoc = await User.findById(this.user);
    let creationCount = userDoc ? userDoc.resumeCreationCount : 0;
    
    // Self-healing auto-migration for existing users if field is missing
    if (userDoc && (userDoc.resumeCreationCount === undefined || userDoc.resumeCreationCount === null)) {
      const existingCount = await this.constructor.countDocuments({ user: this.user });
      creationCount = existingCount;
      await User.findByIdAndUpdate(this.user, { resumeCreationCount: existingCount });
    }

    if (creationCount >= 2) {
      const err = new Error('You have used all 2 resume creations available for your account. Deleting a resume will not restore your creation limit.');
      err.code = 'RESUME_CREATION_LIMIT_REACHED';
      err.status = 403;
    }
  }
  // next();
});

const Resume = mongoose.model('Resume', resumeSchema);
module.exports = Resume;