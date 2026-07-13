// services/careerProfileService.js
// ============================================================
// AI Career Profile Extraction Pipeline
// ============================================================
// Called fire-and-forget AFTER every resume save.
// Never blocks the HTTP response — errors are logged but never crash the app.
//
// Pipeline Steps:
//   1. Build a structured text representation from the resume document
//   2. Call GPT-4o-mini to extract career intelligence (JSON output)
//   3. Call OpenAI Embeddings to generate a 1536-dim vector
//   4. Persist enriched careerProfile back to the Resume document
//   5. Sync User.quickProfile cache for fast lookups
// ============================================================

const OpenAI = require('openai');
const User   = require('../models/User');

// Lazy-initialise so the module loads even without an API key in tests
let openai;
function getOpenAI() {
  if (!openai) {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 10000,
      maxRetries: 0
    });
  }
  return openai;
}

// ── 1. Build a flat text representation of the resume ──────────────────────
function buildResumeText(resume) {
  const parts = [];

  // Personal + role
  const name = [resume.personalInfo?.firstName, resume.personalInfo?.lastName]
    .filter(Boolean).join(' ');
  if (name)                                       parts.push(`Name: ${name}`);
  if (resume.professionalSummary?.title)          parts.push(`Role: ${resume.professionalSummary.title}`);
  if (resume.professionalSummary?.experienceLevel) parts.push(`Level: ${resume.professionalSummary.experienceLevel}`);
  if (resume.professionalSummary?.summary)         parts.push(`Summary: ${resume.professionalSummary.summary}`);

  // Skills
  const skillNames = (resume.skills || []).map(s => s.name).filter(Boolean);
  if (skillNames.length) parts.push(`Skills: ${skillNames.join(', ')}`);

  // Work experience
  (resume.workExperience || []).forEach(w => {
    if (w.company || w.position) {
      parts.push(`Experience: ${w.position || ''} at ${w.company || ''} — ${w.description || ''}`);
      if (w.achievements?.length) parts.push(`Achievements: ${w.achievements.join('; ')}`);
    }
  });

  // Education
  (resume.education || []).forEach(e => {
    if (e.institution || e.degree) {
      parts.push(`Education: ${e.degree || ''} in ${e.fieldOfStudy || ''} at ${e.institution || ''}`);
    }
  });

  // Certifications
  (resume.certifications || []).forEach(c => {
    if (c.name) parts.push(`Certification: ${c.name} from ${c.organization || ''}`);
  });

  // Projects
  (resume.projects || []).forEach(p => {
    if (p.name) {
      const techs = (p.technologies || []).join(', ');
      parts.push(`Project: ${p.name} — ${p.description || ''} [${techs}]`);
    }
  });

  // Target career goals
  const targets = (resume.targetJobs || []);
  if (resume.targetJob?.jobTitle) targets.push(resume.targetJob);
  if (targets.length) {
    const roles = targets.map(t => t.jobTitle).filter(Boolean).join(', ');
    const industries = [...new Set(targets.map(t => t.industry).filter(Boolean))].join(', ');
    const locations  = [...new Set(targets.map(t => t.location).filter(Boolean))].join(', ');
    if (roles)      parts.push(`Target Roles: ${roles}`);
    if (industries) parts.push(`Target Industries: ${industries}`);
    if (locations)  parts.push(`Preferred Locations: ${locations}`);
  }

  // Languages
  const langs = (resume.languages || []).map(l => l.name).filter(Boolean);
  if (langs.length) parts.push(`Languages: ${langs.join(', ')}`);

  return parts.join('\n');
}

// ── 2. Calculate total years of experience from workExperience dates ────────
function calcTotalYearsExp(workExperience = []) {
  let total = 0;
  workExperience.forEach(w => {
    if (w.startDate) {
      const start = new Date(w.startDate);
      const end   = w.current ? new Date() : (w.endDate ? new Date(w.endDate) : new Date());
      const years = (end - start) / (365.25 * 24 * 60 * 60 * 1000);
      if (years > 0) total += years;
    }
  });
  return Math.round(total * 10) / 10; // 1 decimal place
}

// ── 3. Derive seniority from actual experience years ────────────────────────
function deriveSeniority(years) {
  if (years < 1)  return 'Intern';
  if (years < 2)  return 'Junior';
  if (years < 4)  return 'Mid-Level';
  if (years < 7)  return 'Senior';
  if (years < 12) return 'Lead';
  return 'Principal / Director';
}

// ── 4. Call GPT-4o-mini for AI enrichment ───────────────────────────────────
async function callAIEnrichment(resumeText) {
  const client = getOpenAI();

  const systemPrompt = `You are a career intelligence engine. Analyse the resume text provided and return ONLY a valid JSON object with the following structure. Do not add any markdown, explanation, or extra text — output raw JSON only.

{
  "technicalSkills":    [],   // Programming languages, technologies, tools explicitly mentioned
  "frameworks":         [],   // Frameworks and libraries
  "programmingLanguages": [], // Only pure programming languages (Python, JS, Java…)
  "softSkills":         [],   // Leadership, Communication, Teamwork etc.
  "tools":              [],   // IDEs, DevOps tools, productivity tools
  "databases":          [],   // MongoDB, PostgreSQL, MySQL, Redis etc.
  "cloud":              [],   // AWS, GCP, Azure etc.
  "domainExpertise":    [],   // e.g. "Full Stack Development", "Machine Learning", "Cybersecurity"
  "industryBackground": [],   // Industries worked in: FinTech, EdTech, HealthTech etc.
  "strengthAreas":      [],   // 3-5 areas where this candidate excels
  "improvementAreas":   [],   // 2-3 areas to improve for better employability
  "atsKeywords":        [],   // Top 15-20 ATS-optimised keywords for this candidate's profile
  "openToRemote":       false,
  "openToRelocation":   false,
  "profileStrengthScore": 0   // 0-100: overall profile quality score
}`;

  const completion = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    temperature: 0.2,
    max_tokens: 1200,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: `Resume:\n${resumeText}` }
    ],
    response_format: { type: 'json_object' }
  });

  const raw = completion.choices[0]?.message?.content || '{}';
  return JSON.parse(raw);
}

// ── 5. Generate OpenAI embedding for the profile text ───────────────────────
async function generateEmbedding(text) {
  const client = getOpenAI();
  const response = await client.embeddings.create({
    model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
    input: text.slice(0, 8000) // stay well within 8K token limit
  });
  return response.data[0].embedding; // 1536-dim array
}

// ── 6. Derive preferred roles / industries / locations from targetJobs ───────
function deriveCareerIntent(resume) {
  const targets = [...(resume.targetJobs || [])];
  if (resume.targetJob?.jobTitle) targets.push(resume.targetJob);

  const roles      = [...new Set(targets.map(t => t.jobTitle).filter(Boolean))];
  const industries = [...new Set(targets.map(t => t.industry).filter(Boolean))];
  const locations  = [...new Set(targets.map(t => t.location).filter(Boolean))];

  // Salary range — parse from string like "50000-80000" or "50k-80k"
  let salaryMin = 0, salaryMax = 0;
  targets.forEach(t => {
    if (t.desiredSalary) {
      const nums = t.desiredSalary.replace(/k/gi, '000').match(/\d+/g);
      if (nums?.length === 2) {
        salaryMin = Math.max(salaryMin, parseInt(nums[0]));
        salaryMax = Math.max(salaryMax, parseInt(nums[1]));
      }
    }
  });

  return { roles, industries, locations, salaryMin, salaryMax };
}

// ── MAIN EXPORT: triggerCareerProfileEnrichment ──────────────────────────────
/**
 * Fire-and-forget: call this after resume.save() resolves.
 * It runs asynchronously without blocking the HTTP response.
 *
 * @param {string} resumeId   - The MongoDB _id of the saved resume
 * @param {string} userId     - The User._id who owns the resume
 */
async function triggerCareerProfileEnrichment(resumeId, userId) {
  // Guard: require OpenAI key
  if (!process.env.OPENAI_API_KEY) {
    console.warn('⚠️  OPENAI_API_KEY not set — skipping career profile enrichment');
    return;
  }

  try {
    // Need a fresh require inside the function to avoid circular dep issues
    const Resume = require('../models/Resume');

    console.log(`🧠 [CareerProfile] Starting enrichment for resume: ${resumeId}`);

    // Fetch the resume WITHOUT the embedding vector (no need here)
    const resume = await Resume.findById(resumeId);
    if (!resume) {
      console.error(`🧠 [CareerProfile] Resume not found: ${resumeId}`);
      return;
    }

    // ── Step A: Build text ───────────────────────────────────────────────────
    const resumeText = buildResumeText(resume);
    if (resumeText.length < 50) {
      console.log(`🧠 [CareerProfile] Resume too sparse for enrichment (${resumeText.length} chars), skipping`);
      return;
    }

    // ── Step B: Calculate experience years & seniority ──────────────────────
    const totalYears = calcTotalYearsExp(resume.workExperience);
    const seniority  = deriveSeniority(totalYears);

    // ── Step C: Call AI enrichment (GPT-4o-mini, JSON mode) ─────────────────
    let aiData = {};
    try {
      aiData = await callAIEnrichment(resumeText);
      console.log(`🧠 [CareerProfile] AI enrichment complete for ${resumeId}`);
    } catch (aiErr) {
      console.error(`🧠 [CareerProfile] AI enrichment failed: ${aiErr.message} — continuing with partial data`);
    }

    // ── Step D: Generate embedding vector ───────────────────────────────────
    let embeddingVector = null;
    try {
      embeddingVector = await generateEmbedding(resumeText);
      console.log(`🧠 [CareerProfile] Embedding generated (${embeddingVector.length} dims) for ${resumeId}`);
    } catch (embErr) {
      console.error(`🧠 [CareerProfile] Embedding failed: ${embErr.message} — skipping vector`);
    }

    // ── Step E: Derive career intent from targetJobs ─────────────────────────
    const intent = deriveCareerIntent(resume);

    // ── Step F: Compose the full careerProfile object ────────────────────────
    const careerProfile = {
      extractedSkills: {
        technical:   aiData.technicalSkills        || [],
        frameworks:  aiData.frameworks              || [],
        languages:   aiData.programmingLanguages    || [],
        softSkills:  aiData.softSkills              || [],
        tools:       aiData.tools                   || [],
        databases:   aiData.databases               || [],
        cloud:       aiData.cloud                   || []
      },
      domainExpertise:       aiData.domainExpertise    || [],
      seniority,
      totalYearsExperience:  totalYears,
      industryBackground:    aiData.industryBackground || [],
      preferredRoles:        intent.roles,
      preferredIndustries:   intent.industries,
      preferredLocations:    intent.locations,
      preferredSalaryMin:    intent.salaryMin,
      preferredSalaryMax:    intent.salaryMax,
      openToRemote:          aiData.openToRemote       ?? false,
      openToRelocation:      aiData.openToRelocation   ?? false,
      atsKeywords:           aiData.atsKeywords         || [],
      atsScore:              aiData.profileStrengthScore || 0,
      strengthAreas:         aiData.strengthAreas       || [],
      improvementAreas:      aiData.improvementAreas    || [],
      lastAnalyzedAt:        new Date(),
      analysisVersion:       '1.0.0',
      profileStrengthScore:  aiData.profileStrengthScore || 0,
      isEnriched:            true
    };

    // Include embedding if successfully generated
    if (embeddingVector) {
      careerProfile.embedding = {
        vector:      embeddingVector,
        model:       process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
        generatedAt: new Date(),
        version:     1
      };
    }

    // ── Step G: Save careerProfile to Resume (bypass pre-save hooks) ─────────
    await Resume.findByIdAndUpdate(
      resumeId,
      { $set: { careerProfile } },
      { new: false, runValidators: false }
    );
    console.log(`✅ [CareerProfile] Saved to resume ${resumeId}`);

    // ── Step H: Auto-set isPrimary if this is the user's only resume ─────────
    const resumeCount = await Resume.countDocuments({ user: userId });
    if (resumeCount === 1) {
      await Resume.findByIdAndUpdate(resumeId, { $set: { isPrimary: true } }, { runValidators: false });
    }

    // ── Step I: Sync User.quickProfile cache ─────────────────────────────────
    const topSkills = [
      ...(aiData.technicalSkills   || []),
      ...(aiData.frameworks        || []),
      ...(aiData.programmingLanguages || [])
    ].slice(0, 5);

    const targetRole = intent.roles[0] || resume.professionalSummary?.title || '';

    await User.findByIdAndUpdate(
      userId,
      {
        $set: {
          careerProfileId: resumeId,
          'quickProfile.topSkills':    topSkills,
          'quickProfile.seniority':    seniority,
          'quickProfile.targetRole':   targetRole,
          'quickProfile.lastSyncedAt': new Date()
        }
      },
      { runValidators: false }
    );
    console.log(`✅ [CareerProfile] User.quickProfile synced for user ${userId}`);

  } catch (err) {
    // Never crash the calling process \u2014 just log
    console.error(`❌ [CareerProfile] Enrichment pipeline error for resume ${resumeId}:`, err.message);
  }
}

module.exports = { triggerCareerProfileEnrichment, buildResumeText, generateEmbedding };
