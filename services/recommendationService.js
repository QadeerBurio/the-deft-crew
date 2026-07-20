// services/recommendationService.js
// ============================================================
// Redesigned Production-Grade Hybrid Recommendation Engine
// ============================================================
// Implements a 9-stage recommendation pipeline including:
//   1. Hard Filters (strict location, Remote, experience, degree)
//   2. Candidate & Job Understanding (enriched details)
//   3. Synonym Normalization (standardised skill names)
//   4. Semantic Matching (precomputed OpenAI embeddings similarity)
//   5. Multidimensional Hybrid Scoring (configurable weights)
//   6. Behavioral Learning Layer (interaction affinity feedback)
//   7. Explainability Payload (structured matching explanation)
//   8. Diversity & Exploration re-ranking (sliding penalties)
//   9. Caching, indexing & page optimizations
// ============================================================

const JobEmbedding = require('../models/JobEmbedding');
const JobInteraction = require('../models/JobInteraction');
const JobApplication = require('../models/JobApplication');
const Resume = require('../models/Resume');
const Job = require('../models/Job');
const { weights, diversity, behavioralAffinity } = require('../config/weights.config');
const { normalizeSkill, normalizeSkills } = require('../utils/skillNormalizer');

// ── Cosine similarity between two vectors ───────────────────────────────────
function cosineSimilarity(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── Flatten career profile skills ──────────────────────────────────────────
function flattenCareerSkills(careerProfile) {
  if (!careerProfile) return [];
  const skills = careerProfile.extractedSkills || {};
  return [
    ...(skills.technical   || []),
    ...(skills.frameworks  || []),
    ...(skills.languages   || []),
    ...(skills.tools       || []),
    ...(skills.databases   || []),
    ...(skills.cloud       || []),
    ...(skills.softSkills  || [])
  ];
}

// ── Flatten raw resume skills for fallback ──────────────────────────────────
function flattenRawSkills(skills = []) {
  return skills.map(s => (typeof s === 'string' ? s : s.name || '')).filter(Boolean);
}

// ── Fetch user interaction history in the last 30 days ───────────────────────
async function fetchUserInteractionProfile(userId) {
  const profile = {
    companies: {}, // companyName -> { view: 0, save: 0, apply: 0, ignore: 0, dismiss: 0 }
    categories: {}, // category -> { view: 0, save: 0, apply: 0, ignore: 0, dismiss: 0 }
    ignoredJobIds: new Set(),
    dismissedJobIds: new Set(),
    savedJobIds: new Set(),
    viewedJobIds: new Set()
  };

  if (!userId) return profile;

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const interactions = await JobInteraction.find({
    userId,
    createdAt: { $gte: thirtyDaysAgo }
  }).populate('jobId', 'companyName category').lean();

  interactions.forEach(inter => {
    if (!inter.jobId) return;
    const { companyName, category } = inter.jobId;
    const type = inter.interactionType;

    // Track specific jobIds
    if (type === 'ignore') profile.ignoredJobIds.add(inter.jobId._id.toString());
    if (type === 'dismiss') profile.dismissedJobIds.add(inter.jobId._id.toString());
    if (type === 'save') profile.savedJobIds.add(inter.jobId._id.toString());
    if (type === 'view') profile.viewedJobIds.add(inter.jobId._id.toString());

    // Aggregate by Company
    if (companyName) {
      if (!profile.companies[companyName]) {
        profile.companies[companyName] = { view: 0, save: 0, apply: 0, ignore: 0, dismiss: 0 };
      }
      profile.companies[companyName][type] = (profile.companies[companyName][type] || 0) + 1;
    }

    // Aggregate by Category
    if (category) {
      if (!profile.categories[category]) {
        profile.categories[category] = { view: 0, save: 0, apply: 0, ignore: 0, dismiss: 0 };
      }
      profile.categories[category][type] = (profile.categories[category][type] || 0) + 1;
    }
  });

  return profile;
}

// ── MAIN: Get personalised recommendations for a user ─────────────────────
/**
 * @param {string} resumeId      MongoDB _id of the user's primary resume
 * @param {string} userId        MongoDB _id of the user
 * @param {Object} options
 * @param {number} options.limit Max results to return (default 10)
 * @param {string} options.excludeJobId  Skip this jobId (used for similar-jobs endpoint)
 * @param {boolean} options.isExternal  Skip internal or external jobs if set
 * @returns {Array}  Sorted, diverse, explainable recommendation objects
 */
async function getHybridRecommendations(resumeId, userId, options = {}) {
  const { limit = 10, excludeJobId = null, isExternal = null } = options;

  try {
    // 1. Fetch Resume
    const resume = await Resume.findById(resumeId)
      .select('careerProfile skills workExperience professionalSummary targetJobs targetJob education personalInfo');

    if (!resume) {
      console.warn(`[Recommendations] Resume not found: ${resumeId}`);
      return [];
    }

    const cp = resume.careerProfile;
    const hasEmbedding = cp?.embedding?.vector?.length === 1536;

    // 2. Candidate Understanding & Skill Normalization
    const rawSkills = hasEmbedding && cp?.extractedSkills
      ? flattenCareerSkills(cp)
      : flattenRawSkills(resume.skills);
    const candidateSkills = normalizeSkills(rawSkills);
    const candidateSeniority = cp?.seniority || resume.professionalSummary?.experienceLevel || 'Mid Level';
    const totalYearsExp = cp?.totalYearsExperience || 0;

    // Retrieve target career goal fields
    const preferredJobTypes = [];
    if (resume.targetJob?.jobType) preferredJobTypes.push(resume.targetJob.jobType);
    (resume.targetJobs || []).forEach(t => t.jobType && preferredJobTypes.push(t.jobType));

    const preferredLocations = [];
    if (resume.targetJob?.location) preferredLocations.push(resume.targetJob.location);
    (resume.targetJobs || []).forEach(t => t.location && preferredLocations.push(t.location));

    const openToRemote = cp?.openToRemote || resume.targetJob?.jobType === 'Remote' || preferredJobTypes.includes('Remote');

    // 3. Retrieve User interaction profiling & already applied list
    const interactionProfile = await fetchUserInteractionProfile(userId);
    let appliedJobIds = new Set();
    if (userId) {
      const applications = await JobApplication.find({ userId }).select('jobId').lean();
      appliedJobIds = new Set(applications.map(a => a.jobId.toString()));
    }

    // ── Stage 1: Hard Filter Query ───────────────────────────────────────────
    const hardQuery = {
      active: true,
      applicationDeadline: { $gte: new Date() }
    };

    const typesToQuery = new Set(['Internship', 'Full-time', 'Contract', 'Part-time', 'Temporary']);
    if (preferredJobTypes.length > 0) {
      typesToQuery.clear();
      preferredJobTypes.forEach(t => typesToQuery.add(t));
    }
    hardQuery.type = { $in: Array.from(typesToQuery) };

    if (isExternal !== null) {
      hardQuery.isExternal = isExternal;
    }

    if (excludeJobId) {
      hardQuery._id = { $ne: excludeJobId };
    }

    // Filter out jobs that candidate already applied to, ignored, or dismissed
    const excludedIds = [
      ...Array.from(appliedJobIds),
      ...Array.from(interactionProfile.ignoredJobIds),
      ...Array.from(interactionProfile.dismissedJobIds)
    ];
    if (excludedIds.length > 0) {
      hardQuery._id = { ...hardQuery._id, $nin: excludedIds };
    }

    // Apply soft/hard remote filter: if candidate is remote-only, strictly fetch Remote locationType
    if (openToRemote && preferredJobTypes.length === 1 && preferredJobTypes[0] === 'Remote') {
      hardQuery.locationType = 'Remote';
    }

    // Fetch candidate jobs (fetch up to 300 to support high ranking accuracy and diversity processing, preventing event loop blocking)
    const candidateJobs = await Job.find(hardQuery)
      .select('_id title department category location locationType type salary salaryMin salaryMax experienceLevel education skills description requirements companyName companyLogo companyWebsite featured urgent applicationDeadline createdAt totalApplications')
      .sort({ featured: -1, urgent: -1, createdAt: -1 })
      .limit(300)
      .lean();

    if (candidateJobs.length === 0) return [];

    // ── Fetch Job Embeddings ────────────────────────────────────────────────
    let embeddingMap = new Map(); // jobId -> 1536-dim vector
    if (hasEmbedding) {
      const jobIds = candidateJobs.map(j => j._id);
      const embeddings = await JobEmbedding.find({ jobId: { $in: jobIds } })
        .select('jobId embedding')
        .lean();
      embeddings.forEach(e => embeddingMap.set(e.jobId.toString(), e.embedding));
    }

    const resumeVector = hasEmbedding ? cp.embedding.vector : null;

    // ── Scoring Loop ────────────────────────────────────────────────────────
    let scoredJobs = candidateJobs.map(job => {
      let finalScore = 0;
      const breakdown = {};
      const matchHighlights = [];

      // A. Semantic Similarity (35%)
      let semanticScore = 0.5; // neutral fallback
      const jobVector = resumeVector ? embeddingMap.get(job._id.toString()) : null;
      if (resumeVector && jobVector) {
        const similarity = cosineSimilarity(resumeVector, jobVector);
        // Remap typical cosine similarity [0.4, 0.95] to [0.0, 1.0]
        semanticScore = Math.max(0, Math.min(1.0, (similarity - 0.4) / 0.55));
        if (semanticScore >= 0.8) matchHighlights.push('Strong profile semantic fit');
        else if (semanticScore >= 0.5) matchHighlights.push('Related domains detected');
      }
      breakdown.semanticSimilarity = semanticScore;
      finalScore += semanticScore * weights.semanticSimilarity;

      // B. Skills Normalization & Classification
      const jobSkills = normalizeSkills(job.skills || []);
      const reqText = (job.requirements || []).join(' ').toLowerCase() + ' ' + (job.description || '').toLowerCase();
      
      const requiredSkills = [];
      const preferredSkills = [];
      jobSkills.forEach(skill => {
        if (reqText.includes(skill.toLowerCase())) {
          requiredSkills.push(skill);
        } else {
          preferredSkills.push(skill);
        }
      });
      // Fallback if none classified as required
      if (requiredSkills.length === 0) {
        const splitIdx = Math.ceil(jobSkills.length * 0.6);
        requiredSkills.push(...jobSkills.slice(0, splitIdx));
        preferredSkills.push(...jobSkills.slice(splitIdx));
      }

      // C. Skill Overlap (20%)
      const matchedSkillsList = jobSkills.filter(s => candidateSkills.includes(s));
      const skillOverlapVal = jobSkills.length > 0 ? (matchedSkillsList.length / jobSkills.length) : 0;
      breakdown.skillOverlap = skillOverlapVal;
      finalScore += skillOverlapVal * weights.skillOverlap;

      // D. Required Skill Coverage (10%)
      const matchedRequired = requiredSkills.filter(s => candidateSkills.includes(s));
      const reqCoverageVal = requiredSkills.length > 0 ? (matchedRequired.length / requiredSkills.length) : 0;
      breakdown.requiredSkillCoverage = reqCoverageVal;
      finalScore += reqCoverageVal * weights.requiredSkillCoverage;

      // E. Preferred Skill Coverage (5%)
      const matchedPreferred = preferredSkills.filter(s => candidateSkills.includes(s));
      const prefCoverageVal = preferredSkills.length > 0 ? (matchedPreferred.length / preferredSkills.length) : 1.0;
      breakdown.preferredSkillCoverage = prefCoverageVal;
      finalScore += prefCoverageVal * weights.preferredSkillCoverage;

      if (matchedRequired.length > 0) {
        matchHighlights.push(`Matches ${matchedRequired.length} of ${requiredSkills.length} required skills`);
      }

      // F. Project Relevance (5%)
      const projectText = (resume.projects || []).map(p => {
        const techs = (p.technologies || []).join(' ');
        return `${p.name} ${p.description || ''} ${techs}`;
      }).join(' ').toLowerCase();
      
      const matchedProjTechs = jobSkills.filter(skill => projectText.includes(skill.toLowerCase()));
      const projRelevanceVal = jobSkills.length > 0 ? (matchedProjTechs.length / jobSkills.length) : 0;
      breakdown.projectRelevance = projRelevanceVal;
      finalScore += projRelevanceVal * weights.projectRelevance;
      if (projRelevanceVal >= 0.5) matchHighlights.push('Projects show relevant technologies');

      // G. Experience Relevance (5%)
      const workPositionText = (resume.workExperience || []).map(w => `${w.position || ''} ${w.description || ''}`).join(' ').toLowerCase();
      const titleKeywords = job.title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const matchedPositionKeywords = titleKeywords.filter(kw => workPositionText.includes(kw));
      const titleMatchExp = titleKeywords.length > 0 ? (matchedPositionKeywords.length / titleKeywords.length) : 0;

      const seniorityMap = { 'Intern': 0, 'Junior': 1, 'Entry Level': 1, 'Mid Level': 2, 'Mid-Level': 2, 'Senior': 3, 'Senior Level': 3, 'Lead': 4, 'Principal / Director': 5, 'Executive': 5 };
      const candSenVal = seniorityMap[candidateSeniority] ?? 2;
      const jobSenVal = seniorityMap[job.experienceLevel || 'Mid Level'] ?? 2;
      const senDiff = Math.abs(candSenVal - jobSenVal);
      const seniorityMatch = senDiff === 0 ? 1.0 : (senDiff === 1 ? 0.6 : 0.2);

      const expRelevanceVal = (titleMatchExp * 0.4) + (seniorityMatch * 0.6);
      breakdown.experienceRelevance = expRelevanceVal;
      finalScore += expRelevanceVal * weights.experienceRelevance;

      // H. Education Relevance (5%)
      const degreeLevels = { 'high school': 1, 'associate degree': 2, 'bachelor\'s degree': 3, 'master\'s degree': 4, 'phd': 5 };
      let highestCandDegree = 0;
      let candGpa = 3.0; // default neutral
      (resume.education || []).forEach(edu => {
        const degLower = (edu.degree || '').toLowerCase();
        for (const [key, val] of Object.entries(degreeLevels)) {
          if (degLower.includes(key)) {
            highestCandDegree = Math.max(highestCandDegree, val);
          }
        }
        if (edu.gpa && edu.gpa > 0) candGpa = Math.max(candGpa, edu.gpa);
      });

      const jobEduRequired = (job.education || "Bachelor's Degree").toLowerCase();
      const jobEduVal = degreeLevels[jobEduRequired] ?? 3;
      const degreeMatch = highestCandDegree >= jobEduVal ? 1.0 : (highestCandDegree > 0 ? 0.4 : 0.0);
      const gpaMatch = Math.min(1.0, candGpa / 4.0);

      const eduRelevanceVal = (degreeMatch * 0.7) + (gpaMatch * 0.3);
      breakdown.educationRelevance = eduRelevanceVal;
      finalScore += eduRelevanceVal * weights.educationRelevance;

      // I. Location Match (5%)
      const jobLocLower = (job.location || '').toLowerCase();
      const isJobRemote = job.locationType === 'Remote' || jobLocLower.includes('remote');
      let locMatchVal = 0.0;
      if (isJobRemote && openToRemote) {
        locMatchVal = 1.0;
      } else if (preferredLocations.length > 0) {
        const matchesPref = preferredLocations.some(loc => jobLocLower.includes(loc.toLowerCase()) || loc.toLowerCase().includes(jobLocLower));
        if (matchesPref) locMatchVal = 1.0;
      } else {
        const candCity = (resume.personalInfo?.city || '').toLowerCase();
        if (candCity && jobLocLower.includes(candCity)) locMatchVal = 1.0;
      }
      breakdown.locationMatch = locMatchVal;
      finalScore += locMatchVal * weights.locationMatch;
      if (locMatchVal === 1.0) matchHighlights.push('Matches your location preference');

      // J. Remote Preference (2%)
      let remotePrefVal = 1.0;
      if (openToRemote && isJobRemote) {
        remotePrefVal = 1.0;
        matchHighlights.push('Matches your remote preference');
      } else if (openToRemote && !isJobRemote) {
        remotePrefVal = 0.2;
      } else if (!openToRemote && isJobRemote) {
        remotePrefVal = 0.5;
      }
      breakdown.remotePreference = remotePrefVal;
      finalScore += remotePrefVal * weights.remotePreference;

      // K. Industry Match (2%)
      const jobCat = (job.category || '').toLowerCase();
      const jobDept = (job.department || '').toLowerCase();
      const prefInds = (cp?.preferredIndustries || []).map(i => i.toLowerCase());
      const indBg = (cp?.industryBackground || []).map(i => i.toLowerCase());
      const matchesPrefInd = prefInds.some(ind => jobCat.includes(ind) || jobDept.includes(ind));
      const matchesBgInd = indBg.some(ind => jobCat.includes(ind) || jobDept.includes(ind));
      const indMatchVal = matchesPrefInd ? 1.0 : (matchesBgInd ? 0.6 : 0.2);
      breakdown.industryMatch = indMatchVal;
      finalScore += indMatchVal * weights.industryMatch;
      if (matchesPrefInd) matchHighlights.push(`Matches target industry: ${job.category}`);

      // L. Career Goal Alignment (2%)
      const jobTitleLower = job.title.toLowerCase();
      const prefRoles = (cp?.preferredRoles || []).map(r => r.toLowerCase());
      const matchesPrefRole = prefRoles.some(role => jobTitleLower.includes(role) || role.includes(jobTitleLower));
      const careerAlignmentVal = matchesPrefRole ? 1.0 : 0.2;
      breakdown.careerGoalAlignment = careerAlignmentVal;
      finalScore += careerAlignmentVal * weights.careerGoalAlignment;
      if (matchesPrefRole) matchHighlights.push('Matches preferred job role title');

      // M. Freshness (2%)
      const daysSincePosted = (Date.now() - new Date(job.createdAt)) / (24 * 60 * 60 * 1000);
      const freshnessVal = Math.exp(-daysSincePosted * 0.05); // Exponential decay (30 days = 22% score)
      breakdown.freshness = freshnessVal;
      finalScore += freshnessVal * weights.freshness;

      // N. Company Quality (2%)
      let compQualVal = 0.5;
      if (job.featured) compQualVal = 1.0;
      if (job.urgent) compQualVal = 0.8;
      breakdown.companyQuality = compQualVal;
      finalScore += compQualVal * weights.companyQuality;

      // O. Salary Relevance (2%)
      let salaryRelevanceVal = 0.5;
      if (job.salaryMin && cp?.preferredSalaryMin) {
        if (job.salaryMin >= cp.preferredSalaryMin && job.salaryMax <= cp.preferredSalaryMax) {
          salaryRelevanceVal = 1.0;
        } else if (job.salaryMax < cp.preferredSalaryMin) {
          salaryRelevanceVal = Math.max(0.1, 1 - (cp.preferredSalaryMin - job.salaryMax) / cp.preferredSalaryMin);
        } else {
          salaryRelevanceVal = 1.0;
        }
      }
      breakdown.salaryRelevance = salaryRelevanceVal;
      finalScore += salaryRelevanceVal * weights.salaryRelevance;

      // P. Behavioral Scoring / Interaction History (Stage 6)
      let affinityBoost = 0;
      const compInteractions = interactionProfile.companies[job.companyName] || {};
      const catInteractions = interactionProfile.categories[job.category] || {};

      affinityBoost += (compInteractions.apply || 0) * behavioralAffinity.applyBoost;
      affinityBoost += (compInteractions.save || 0) * behavioralAffinity.saveBoost;
      affinityBoost += (compInteractions.view || 0) * behavioralAffinity.viewBoost;
      affinityBoost += (compInteractions.ignore || 0) * behavioralAffinity.ignorePenalty;
      affinityBoost += (compInteractions.dismiss || 0) * behavioralAffinity.dismissPenalty;

      affinityBoost += (catInteractions.apply || 0) * behavioralAffinity.applyBoost * 0.5;
      affinityBoost += (catInteractions.save || 0) * behavioralAffinity.saveBoost * 0.5;
      affinityBoost += (catInteractions.view || 0) * behavioralAffinity.viewBoost * 0.5;

      const userInteractionVal = Math.max(0, Math.min(1.0, (affinityBoost + 50) / 100));
      breakdown.userInteraction = userInteractionVal;
      finalScore += userInteractionVal * weights.userInteraction;

      // Q. Specific job interaction details
      const isSaved = interactionProfile.savedJobIds.has(job._id.toString());
      const isViewed = interactionProfile.viewedJobIds.has(job._id.toString());
      
      breakdown.savedJobs = isSaved ? 1.0 : 0.0;
      finalScore += (isSaved ? 1.0 : 0.0) * weights.savedJobs;

      breakdown.previouslyViewed = isViewed ? 1.0 : 0.0;
      finalScore += (isViewed ? 1.0 : 0.0) * weights.previouslyViewed;

      breakdown.previouslyApplied = 0.0; // Filtered out by Stage 1

      // Normalise score to 0-100 range
      const matchPercentage = Math.round(finalScore * 100);

      // Construct structured matching highlights for the front-end dashboard
      const missingRequired = requiredSkills.filter(s => !candidateSkills.includes(s));
      
      const matchedProjects = [];
      (resume.projects || []).forEach(p => {
        const pText = `${p.name} ${p.description || ''} ${(p.technologies || []).join(' ')}`.toLowerCase();
        const hasMatch = jobSkills.some(skill => pText.includes(skill.toLowerCase()));
        if (hasMatch) matchedProjects.push(p.name);
      });

      const matchedExperience = [];
      (resume.workExperience || []).forEach(w => {
        const wText = `${w.position || ''} ${w.company || ''} ${w.description || ''}`.toLowerCase();
        const hasMatch = titleKeywords.some(kw => wText.includes(kw));
        if (hasMatch) matchedExperience.push(`${w.position} at ${w.company}`);
      });

      const matchedEducation = [];
      (resume.education || []).forEach(edu => {
        if (highestCandDegree >= jobEduVal) {
          matchedEducation.push(`${edu.degree} in ${edu.fieldOfStudy || 'CS'}`);
        }
      });

      const matchedLocation = locMatchVal > 0 ? (isJobRemote ? ['Remote'] : [job.location]) : [];

      const explanation = {
        matchPercentage,
        highlights: matchHighlights.slice(0, 4),
        matchedRequiredSkillsCount: matchedRequired.length,
        totalRequiredSkillsCount: requiredSkills.length,
        matchedSkills: matchedRequired.slice(0, 8),
        missingSkills: missingRequired.slice(0, 8),
        matchedProjects: matchedProjects.slice(0, 4),
        matchedExperience: matchedExperience.slice(0, 4),
        matchedEducation: matchedEducation.slice(0, 4),
        matchedLocation
      };

      return {
        ...job,
        matchPercentage,
        matchedSkills: matchedSkillsList.slice(0, 6),
        isRecommended: matchPercentage >= 50,
        explanation,
        breakdown
      };
    });

    // ── Stage 8: Diversity Re-ranking & Penalty ──────────────────────────────
    // Penalize subsequent jobs from the same company or identical categories
    scoredJobs.sort((a, b) => b.matchPercentage - a.matchPercentage);

    const companyCounts = {};
    const categoryCounts = {};
    const finalDiverseList = [];

    for (const scoredItem of scoredJobs) {
      const company = scoredItem.companyName || 'Unknown';
      const category = scoredItem.category || 'Other';

      companyCounts[company] = (companyCounts[company] || 0) + 1;
      categoryCounts[category] = (categoryCounts[category] || 0) + 1;

      // Skip if limit from a single company is exceeded to guarantee diversity
      if (companyCounts[company] > diversity.maxRolesPerCompany) {
        continue;
      }

      // Apply sliding penalties to score
      let penalizedScore = scoredItem.matchPercentage;
      if (companyCounts[company] > 1) {
        penalizedScore -= (companyCounts[company] - 1) * (diversity.companyPenaltyFactor * 100);
      }
      if (categoryCounts[category] > 1) {
        penalizedScore -= (categoryCounts[category] - 1) * (diversity.categoryPenaltyFactor * 100);
      }

      scoredItem.matchPercentage = Math.max(0, Math.round(penalizedScore));
      scoredItem.explanation.matchPercentage = scoredItem.matchPercentage;

      finalDiverseList.push(scoredItem);
    }

    // Final Sort by diverse Match Percentage DESC, then recency
    finalDiverseList.sort((a, b) => {
      if (b.matchPercentage !== a.matchPercentage) return b.matchPercentage - a.matchPercentage;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    return finalDiverseList.slice(0, limit);

  } catch (err) {
    console.error('[Recommendations Redesigned] Error:', err);
    return [];
  }
}

// ── Similar jobs: find jobs similar to a given job ─────────────────────────
/**
 * @param {string} jobId    The reference job to find similar ones for
 * @param {number} limit    Max results (default 6)
 */
async function getSimilarJobs(jobId, limit = 6) {
  try {
    const [refJob, refEmbedding] = await Promise.all([
      Job.findById(jobId).lean(),
      JobEmbedding.findOne({ jobId }).select('embedding').lean()
    ]);

    if (!refJob) return [];

    // Candidate pool: active, not same job
    const candidates = await Job.find({
      active: true,
      _id: { $ne: jobId },
      type: 'Internship',
      applicationDeadline: { $gte: new Date() }
    })
      .sort({ createdAt: -1 })
      .limit(100)
      .select('_id title department category location locationType type salary experienceLevel skills companyName companyLogo featured urgent applicationDeadline createdAt')
      .lean();

    if (!refEmbedding?.embedding || candidates.length === 0) {
      // Fallback: return jobs from same category
      return candidates
        .filter(c => c.category === refJob.category)
        .slice(0, limit)
        .map(j => ({ ...j, similarityScore: 0 }));
    }

    const candidateIds = candidates.map(j => j._id);
    const embeddings = await JobEmbedding.find({ jobId: { $in: candidateIds } })
      .select('jobId embedding')
      .lean();

    const embMap = new Map(embeddings.map(e => [e.jobId.toString(), e.embedding]));

    const scored = candidates.map(job => {
      const vec = embMap.get(job._id.toString());
      const sim = vec ? cosineSimilarity(refEmbedding.embedding, vec) : 0;
      return { ...job, similarityScore: Math.round(sim * 100) };
    });

    scored.sort((a, b) => b.similarityScore - a.similarityScore);
    return scored.slice(0, limit);

  } catch (err) {
    console.error('[SimilarJobs Redesigned] Error:', err.message);
    return [];
  }
}

module.exports = {
  getHybridRecommendations,
  getSimilarJobs,
  cosineSimilarity
};
