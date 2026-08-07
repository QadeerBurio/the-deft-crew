// services/resumeTailorService.js
// ============================================================
// AI Resume Tailoring Service
// ============================================================
// Takes an existing resume and a target job (via jobId or description text).
// Uses GPT-4o-mini to generate an ATS-optimized, tailored version:
//   1. Aligns the professional summary and title.
//   2. Fuses & updates skills list (incorporates missing keywords).
//   3. Rewrites experience bullet points (STAR method, active verbs, metrics).
//   4. Refines project tech descriptions.
//   5. Pick the best matching version tag from allowed list.
//
// Saves the result as a new Resume document (version draft).
// ============================================================

const OpenAI = require('openai');
const Resume = require('../models/Resume');
const User   = require('../models/User');
const Job    = require('../models/Job');

let openai;
function getOpenAI() {
  if (!openai) {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 45000,
      maxRetries: 2
    });
  }
  return openai;
}

// Allowed version tags in Resume model
const VALID_VERSION_TAGS = [
  'General', 'Backend', 'Frontend', 'AI/ML', 'Data Science',
  'DevOps', 'Mobile', 'Cybersecurity', 'Design', 'Management'
];

/**
 * AI-tailors an existing resume for a target job.
 * Creates a new Resume document representing this tailored version.
 *
 * @param {string} sourceResumeId - Resume ID to copy & tailor
 * @param {string} userId - Owner of the resume
 * @param {Object} targetInfo
 * @param {string} [targetInfo.jobId] - Optional Job ID
 * @param {string} [targetInfo.jobDescription] - Optional raw JD text
 * @returns {Promise<Object>} The new saved Resume document
 */
async function tailorResume(sourceResumeId, userId, targetInfo = {}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured on this server');
  }

  // 1. Fetch source resume
  const sourceResume = await Resume.findOne({ _id: sourceResumeId, user: userId });
  if (!sourceResume) {
    throw new Error('Source resume not found');
  }

  // 2. Resolve job info
  let jobTitle = 'Target Role';
  let companyName = 'Target Company';
  let jobDetailsText = '';

  if (targetInfo.jobId) {
    const job = await Job.findById(targetInfo.jobId);
    if (!job) throw new Error('Target job not found');
    jobTitle = job.title;
    companyName = job.companyName || 'Target Company';
    jobDetailsText = `Job Title: ${job.title}
Company: ${companyName}
Required Skills: ${(job.skills || []).join(', ')}
Requirements: ${(job.requirements || []).join('; ')}
Description: ${job.description}`;
  } else if (targetInfo.jobDescription) {
    jobDetailsText = targetInfo.jobDescription;
    // Extract a title/company if possible from the start of the text
    const lines = targetInfo.jobDescription.split('\n').slice(0, 3);
    jobTitle = lines[0]?.substring(0, 50) || 'Target Role';
  } else {
    throw new Error('Either jobId or jobDescription must be provided to tailor a resume');
  }

  // 3. Construct GPT Prompt
  const cleanSource = {
    personalInfo: sourceResume.personalInfo,
    professionalSummary: sourceResume.professionalSummary,
    skills: sourceResume.skills,
    workExperience: sourceResume.workExperience,
    projects: sourceResume.projects,
    education: sourceResume.education,
    certifications: sourceResume.certifications,
    languages: sourceResume.languages,
    interests: sourceResume.interests,
    references: sourceResume.references
  };

  const prompt = `You are a world-class ATS Resume Optimization expert. Your goal is to tailor the candidate's resume to the target job description to maximize the ATS compatibility and human recruiter appeal.

Allowed Resume Version Tags:
${VALID_VERSION_TAGS.map(t => `- "${t}"`).join('\n')}

SOURCE RESUME JSON:
${JSON.stringify(cleanSource, null, 2)}

TARGET JOB DETAILS:
${jobDetailsText}

INSTRUCTIONS FOR TAILORING:
1. **Professional Summary**: Rewrite the title and summary to align closely with the target job's key themes, keywords, and seniority level. Maintain an authentic, professional tone. Fix any grammatical or spelling issues.
2. **Skills**: Optimize the skills list. Retain the candidate's existing core skills, and add critical keywords/technologies from the job description if they are reasonably aligned with the candidate's background. Assign realistic proficiency levels ('Beginner', 'Intermediate', 'Advanced', 'Expert') and categories ('Technical', 'Soft Skills', 'Language', 'Other').
3. **Work Experience**: Rewrite descriptions and achievements (the "achievements" string array) for each role to emphasize relevance to the target job. Use the STAR method (Situation, Task, Action, Result) with strong action verbs. Highlight achievements, tools, and outcomes that matter for the target job. Incorporate metrics or quantifiable results where plausible.
4. **Projects**: Align technology lists and descriptions with target job needs, improving readability and impact.
5. **Education / Certifications / Languages**: Retain these exactly as they are in the source, but format them cleanly.
6. **Version Tag**: Pick the single best tag from the "Allowed Resume Version Tags" list above that describes this tailored resume's focus.
7. **Duplication & Formatting**: Scan the output to remove any duplicated content across sections. Ensure clean formatting throughout.
8. **CRITICAL GUARDRAIL - TRUTHFULNESS & VERACITY**:
   - Keep all information strictly truthful.
   - You must NEVER invent fake experience, education, degrees, schools, certifications, skills, or achievements.
   - Do NOT invent companies, job roles, or project details that the candidate did not list.
   - Only optimize existing details and highlight matching keywords. Do not fabricate credentials.

Return ONLY a valid JSON object matching this structure (do not wrap in markdown or add explanations):
{
  "professionalSummary": {
    "title": "string",
    "summary": "string"
  },
  "skills": [
    { "name": "string", "level": "Beginner|Intermediate|Advanced|Expert", "category": "Technical|Soft Skills|Language|Other" }
  ],
  "workExperience": [
    {
      "company": "string",
      "position": "string",
      "location": "string",
      "startDate": "ISO-date or null",
      "endDate": "ISO-date or null",
      "current": true/false,
      "description": "string",
      "achievements": ["string", "string"],
      "companyWebsite": "string"
    }
  ],
  "projects": [
    {
      "name": "string",
      "description": "string",
      "technologies": ["string"],
      "startDate": "ISO-date or null",
      "endDate": "ISO-date or null",
      "url": "string",
      "githubUrl": "string"
    }
  ],
  "versionTag": "One of the Allowed Resume Version Tags"
}`;

  console.log(`🤖 [ResumeTailor] Tailoring resume ${sourceResumeId} for job: "${jobTitle}" at "${companyName}"`);

  const client = getOpenAI();
  const completion = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    temperature: 0.3,
    max_tokens: 2500,
    messages: [
      { role: 'system', content: 'You are an ATS optimization AI. Return raw JSON matching the requested structure.' },
      { role: 'user',   content: prompt }
    ],
    response_format: { type: 'json_object' }
  });

  const rawText = completion.choices[0]?.message?.content || '{}';
  const parsedResponse = JSON.parse(rawText);

  // 4. Combine tailored sections with non-altered sections
  const tailoredResumeData = {
    user: userId,
    personalInfo: sourceResume.personalInfo,
    education: sourceResume.education,
    certifications: sourceResume.certifications,
    languages: sourceResume.languages,
    interests: sourceResume.interests,
    references: sourceResume.references,
    
    // Tailored sections from AI response
    professionalSummary: parsedResponse.professionalSummary || sourceResume.professionalSummary,
    skills: parsedResponse.skills || sourceResume.skills,
    workExperience: parsedResponse.workExperience || sourceResume.workExperience,
    projects: parsedResponse.projects || sourceResume.projects,
    
    // Version meta info
    versionTag: VALID_VERSION_TAGS.includes(parsedResponse.versionTag) ? parsedResponse.versionTag : 'General',
    versionNotes: `Tailored for ${jobTitle} at ${companyName}`,
    isPrimary: false, // Tailored resumes are drafts, not primary by default
    template: sourceResume.template || 'modern'
  };

  // 5. Save as a new Resume document
  const newResume = new Resume(tailoredResumeData);
  await newResume.save();

  // Increment user lifetime resume creation count
  await User.findByIdAndUpdate(userId, { $inc: { resumeCreationCount: 1 } });

  console.log(`✅ [ResumeTailor] Saved new tailored resume version: ${newResume._id} with tag: "${newResume.versionTag}"`);
  return newResume;
}

module.exports = { tailorResume };
