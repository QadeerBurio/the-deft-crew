// services/skillGapService.js
// ============================================================
// AI-Powered Skill Gap Analysis Service
// ============================================================
// Given a resumeId + jobId, this service:
//   1. Checks cache (SkillGapCache) — returns instantly if fresh
//   2. Fetches resume careerProfile + raw skills
//   3. Fetches job requirements + skills
//   4. Runs GPT-4o-mini analysis in JSON mode
//   5. Saves result to cache
//   6. Returns structured analysis
//
// Also provides:
//   - validateApplication()  — "should I apply?" decision
//   - invalidateCacheForResume() — call on resume update
// ============================================================

const OpenAI = require('openai');
const SkillGapCache = require('../models/SkillGapCache');

let openai;
function getOpenAI() {
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

// ── Flatten all candidate skills into a normalised list ─────────────────────
function flattenCandidateSkills(resume) {
  // Prefer AI-extracted skills (careerProfile), fallback to raw resume.skills
  const cp = resume.careerProfile;
  if (cp?.isEnriched && cp.extractedSkills) {
    const es = cp.extractedSkills;
    const combined = [
      ...(es.technical   || []).map(s => ({ name: s, level: 'Intermediate', source: 'ai' })),
      ...(es.frameworks  || []).map(s => ({ name: s, level: 'Intermediate', source: 'ai' })),
      ...(es.languages   || []).map(s => ({ name: s, level: 'Intermediate', source: 'ai' })),
      ...(es.tools       || []).map(s => ({ name: s, level: 'Intermediate', source: 'ai' })),
      ...(es.databases   || []).map(s => ({ name: s, level: 'Intermediate', source: 'ai' })),
      ...(es.cloud       || []).map(s => ({ name: s, level: 'Intermediate', source: 'ai' })),
      ...(es.softSkills  || []).map(s => ({ name: s, level: 'Intermediate', source: 'ai' }))
    ];
    // Merge with raw skills to get explicit proficiency levels
    (resume.skills || []).forEach(rawSkill => {
      const match = combined.find(c => c.name.toLowerCase() === (rawSkill.name || '').toLowerCase());
      if (match) match.level = rawSkill.level || 'Intermediate';
    });
    return combined;
  }

  // Raw fallback
  return (resume.skills || []).map(s => ({
    name: s.name || '',
    level: s.level || 'Intermediate',
    source: 'raw'
  })).filter(s => s.name);
}

// ── Build the GPT prompt ─────────────────────────────────────────────────────
function buildAnalysisPrompt(candidateSkills, resume, job) {
  const candidateSkillText = candidateSkills
    .map(s => `  - ${s.name} (${s.level})`)
    .join('\n');

  const jobSkillText = (job.skills || []).join(', ') || 'Not specified';
  const jobReqText   = (job.requirements || []).slice(0, 8).join('\n  ') || 'Not specified';

  const seniority   = resume.careerProfile?.seniority || resume.professionalSummary?.experienceLevel || 'Mid Level';
  const totalYears  = resume.careerProfile?.totalYearsExperience || 0;
  const targetRole  = resume.professionalSummary?.title || '';
  const atsKeywords = (resume.careerProfile?.atsKeywords || []).slice(0, 10).join(', ');

  return `You are a senior technical recruiter and career coach performing a precise skill gap analysis.

CANDIDATE PROFILE:
- Current Role: ${targetRole}
- Seniority: ${seniority}
- Years of Experience: ${totalYears}
- Key ATS Keywords: ${atsKeywords || 'None detected'}

CANDIDATE SKILLS:
${candidateSkillText || '  (No skills listed)'}

JOB POSTING:
- Title: ${job.title}
- Company: ${job.companyName || 'Unknown'}
- Experience Required: ${job.experienceLevel}
- Required Skills: ${jobSkillText}
- Requirements:
  ${jobReqText}
- Description: ${(job.description || '').slice(0, 600)}

Analyse the fit between the candidate and this job. Return ONLY valid JSON (no markdown, no explanation):

{
  "overallMatchScore": 0-100,
  "atsCompatibilityScore": 0-100,
  "shouldApply": true/false,
  "confidence": "low|medium|high",
  "matchedSkills": [
    { "skill": "string", "candidateLevel": "Beginner|Intermediate|Advanced|Expert", "required": true/false }
  ],
  "missingSkills": [
    {
      "skill": "string",
      "importance": "critical|important|nice-to-have",
      "learnTimeWeeks": number,
      "resources": ["platform1", "platform2"]
    }
  ],
  "partialSkills": [
    {
      "skill": "string",
      "candidateLevel": "string",
      "requiredLevel": "string",
      "gapDescription": "one sentence"
    }
  ],
  "strengths": ["string", "string", "string"],
  "weaknesses": ["string", "string"],
  "recommendation": "2-3 sentence honest career coach recommendation",
  "coverLetterHints": ["string", "string", "string"]
}`;
}

// ── MAIN: analyseSkillGap ────────────────────────────────────────────────────
/**
 * Analyse the skill gap between a resume and a job.
 * Results are cached for 24h — subsequent calls for same (resumeId, jobId) are instant.
 *
 * @param {string} resumeId   MongoDB _id of the resume
 * @param {string} jobId      MongoDB _id of the job
 * @param {boolean} forceRefresh  Skip cache and re-run analysis
 * @returns {Object} Full skill gap analysis result
 */
async function analyseSkillGap(resumeId, jobId, forceRefresh = false) {
  // ── 1. Check cache ───────────────────────────────────────────────────────
  if (!forceRefresh) {
    const cached = await SkillGapCache.findOne({
      resumeId,
      jobId,
      expiresAt: { $gt: new Date() }
    });
    if (cached) {
      console.log(`✅ [SkillGap] Cache HIT for resume:${resumeId} job:${jobId}`);
      return { ...cached.toObject(), fromCache: true };
    }
  }

  // ── 2. Fetch resume and job ─────────────────────────────────────────────
  const Resume = require('../models/Resume');
  const Job    = require('../models/Job');

  const [resume, job] = await Promise.all([
    Resume.findById(resumeId)
      .select('careerProfile skills workExperience professionalSummary personalInfo'),
    Job.findById(jobId)
      .select('title companyName experienceLevel skills requirements description minExperience')
  ]);

  if (!resume) throw new Error('Resume not found');
  if (!job)    throw new Error('Job not found');

  // ── 3. Build candidate skill list ──────────────────────────────────────
  const candidateSkills = flattenCandidateSkills(resume);

  // ── 4. Rule-based pre-analysis (fast, no API cost) ─────────────────────
  const jobSkillsLower = (job.skills || []).map(s => s.toLowerCase().trim());
  const candidateSkillsLower = candidateSkills.map(s => s.name.toLowerCase().trim());

  const ruleMatchedSkills = [];
  const ruleMissingSkills = [];

  jobSkillsLower.forEach((jSkill, i) => {
    const found = candidateSkillsLower.some(cSkill =>
      cSkill === jSkill || cSkill.includes(jSkill) || jSkill.includes(cSkill)
    );
    if (found) {
      const matchedCS = candidateSkills.find(c => c.name.toLowerCase().includes(jSkill) || jSkill.includes(c.name.toLowerCase()));
      ruleMatchedSkills.push({
        skill: job.skills[i],
        candidateLevel: matchedCS?.level || 'Intermediate',
        required: true
      });
    } else {
      ruleMissingSkills.push(job.skills[i]);
    }
  });

  const ruleMatchPct = jobSkillsLower.length > 0
    ? Math.round((ruleMatchedSkills.length / jobSkillsLower.length) * 100)
    : 50;

  // ── 5. AI enrichment (if API key available and resume has enough data) ───
  let aiResult = null;

  if (process.env.OPENAI_API_KEY && candidateSkills.length >= 1) {
    try {
      const prompt = buildAnalysisPrompt(candidateSkills, resume, job);
      const client = getOpenAI();

      const completion = await client.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        temperature: 0.1,  // Very deterministic for analysis tasks
        max_tokens: 1500,
        messages: [
          { role: 'system', content: 'You are a precise career analysis AI. Output only valid JSON.' },
          { role: 'user',   content: prompt }
        ],
        response_format: { type: 'json_object' }
      });

      const raw = completion.choices[0]?.message?.content || '{}';
      aiResult = JSON.parse(raw);
      console.log(`✅ [SkillGap] AI analysis complete for resume:${resumeId} job:${jobId}`);
    } catch (aiErr) {
      console.error(`⚠️  [SkillGap] AI analysis failed: ${aiErr.message} — using rule-based fallback`);
    }
  }

  // ── 6. Merge rule-based + AI results ────────────────────────────────────
  const result = {
    resumeId,
    jobId,
    overallMatchScore:     aiResult?.overallMatchScore     ?? ruleMatchPct,
    atsCompatibilityScore: aiResult?.atsCompatibilityScore ?? Math.min(ruleMatchPct + 5, 100),
    shouldApply:           aiResult?.shouldApply           ?? ruleMatchPct >= 40,
    confidence:            aiResult?.confidence            ?? (aiResult ? 'high' : 'low'),
    matchedSkills:         aiResult?.matchedSkills         ?? ruleMatchedSkills,
    missingSkills:         aiResult?.missingSkills         ?? ruleMissingSkills.slice(0, 6).map(s => ({
      skill:          s,
      importance:     'important',
      learnTimeWeeks: 4,
      resources:      ['Coursera', 'Udemy', 'YouTube']
    })),
    partialSkills:         aiResult?.partialSkills         ?? [],
    strengths:             aiResult?.strengths             ?? [],
    weaknesses:            aiResult?.weaknesses            ?? [],
    recommendation:        aiResult?.recommendation        ?? (
      ruleMatchPct >= 70
        ? 'Strong match — apply with confidence.'
        : ruleMatchPct >= 40
          ? 'Moderate match — tailor your cover letter to address skill gaps.'
          : 'Significant gap — consider building missing skills before applying.'
    ),
    coverLetterHints:      aiResult?.coverLetterHints      ?? [],
    analysisVersion:       '1.0.0',
    generatedAt:           new Date(),
    fromCache:             false
  };

  // ── 7. Upsert into cache ─────────────────────────────────────────────────
  try {
    const cacheDoc = { ...result };
    delete cacheDoc._id;
    delete cacheDoc.fromCache;
    cacheDoc.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    await SkillGapCache.findOneAndUpdate(
      { resumeId, jobId },
      { $set: cacheDoc },
      { upsert: true, new: true, runValidators: false }
    );
    console.log(`✅ [SkillGap] Analysis cached for resume:${resumeId} job:${jobId}`);
  } catch (cacheErr) {
    console.warn(`⚠️  [SkillGap] Failed to cache result: ${cacheErr.message}`);
  }

  return result;
}

// ── Validate Application: is it safe to apply right now? ────────────────────
/**
 * Lightweight validation that checks for critical mismatches before applying.
 * Returns a detailed go/no-go recommendation with action items.
 *
 * @param {string} resumeId
 * @param {string} jobId
 */
async function validateApplication(resumeId, jobId) {
  const analysis = await analyseSkillGap(resumeId, jobId);

  const criticalMissing = (analysis.missingSkills || []).filter(s => s.importance === 'critical');
  const totalMissing    = (analysis.missingSkills || []).length;
  const matchScore      = analysis.overallMatchScore || 0;

  let verdict = 'apply';        // apply | apply_with_prep | reconsider | do_not_apply
  let urgency = 'low';          // low | medium | high
  let message = '';

  if (matchScore >= 75 && criticalMissing.length === 0) {
    verdict = 'apply';
    urgency = 'low';
    message = 'Excellent fit. Apply today — your profile is a strong match.';
  } else if (matchScore >= 50 && criticalMissing.length <= 1) {
    verdict = 'apply_with_prep';
    urgency = 'medium';
    message = `Good match. Tailor your cover letter and highlight: ${
      (analysis.strengths || []).slice(0, 2).join(', ') || 'your strongest skills'
    }.`;
  } else if (matchScore >= 30 && criticalMissing.length <= 3) {
    verdict = 'reconsider';
    urgency = 'high';
    const topGaps = criticalMissing.slice(0, 3).map(s => s.skill).join(', ');
    message = `Significant gaps in: ${topGaps || 'key required skills'}. Bridge these gaps first or apply with a strong cover letter addressing them.`;
  } else {
    verdict = 'do_not_apply';
    urgency = 'high';
    message = 'Too many critical skill gaps. Building missing skills will increase your success rate significantly.';
  }

  // Estimated time to become ready (sum of critical missing skill learn times)
  const weeksToReady = criticalMissing.reduce((sum, s) => sum + (s.learnTimeWeeks || 4), 0);

  return {
    resumeId,
    jobId,
    verdict,           // apply | apply_with_prep | reconsider | do_not_apply
    urgency,
    message,
    matchScore,
    atsScore:          analysis.atsCompatibilityScore,
    shouldApply:       analysis.shouldApply,
    criticalGaps:      criticalMissing,
    totalMissingCount: totalMissing,
    weeksToReady:      weeksToReady,
    coverLetterHints:  (analysis.coverLetterHints || []).slice(0, 3),
    topStrengths:      (analysis.strengths || []).slice(0, 3),
    analysisId:        analysis._id
  };
}

// ── Cache invalidation (call on resume update) ───────────────────────────────
async function invalidateCacheForResume(resumeId) {
  try {
    const result = await SkillGapCache.deleteMany({ resumeId });
    console.log(`🗑️  [SkillGap] Invalidated ${result.deletedCount} cache entries for resume: ${resumeId}`);
  } catch (err) {
    console.warn(`⚠️  [SkillGap] Cache invalidation error: ${err.message}`);
  }
}

module.exports = {
  analyseSkillGap,
  validateApplication,
  invalidateCacheForResume,
  flattenCandidateSkills
};
