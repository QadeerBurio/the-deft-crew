// config/weights.config.js
// Configurable weights for the Internship Recommendation Engine.
// These weights combine to 1.0 (100%) and can be adjusted for tuning/A-B testing.

module.exports = {
  weights: {
    semanticSimilarity: 0.35,       // Cosine similarity of resume vs job embedding
    skillOverlap: 0.20,             // General skill matching / overlap
    requiredSkillCoverage: 0.10,    // Missing vs matched required skills
    preferredSkillCoverage: 0.05,   // Match with preferred skills
    projectRelevance: 0.05,         // Technologies/keywords used in candidate projects
    experienceRelevance: 0.05,      // Relevance of prior experience (titles, years)
    educationRelevance: 0.05,       // Match with required degree & GPA
    locationMatch: 0.05,            // Geo proximity / preferred cities
    remotePreference: 0.02,         // Match with Remote work preference
    industryMatch: 0.02,            // Preferred industries/sectors
    careerGoalAlignment: 0.02,      // Match with target job titles
    freshness: 0.02,                // Job recency (fresh jobs rank higher)
    companyQuality: 0.02,           // Featured companies & verified company status
    salaryRelevance: 0.02,          // Matching salary expectations
    userInteraction: 0.02,          // General historical interactions boost
    savedJobs: 0.02,                // Boost if saved/bookmarked (for similar matching)
    previouslyViewed: 0.02,         // Adjustments based on page views
    previouslyApplied: 0.02          // Exclude or adjust (normally filtered out)
  },
  
  // Settings for exploration and diversity
  diversity: {
    companyPenaltyFactor: 0.15,      // Reduce score by 15% for each duplicate company
    categoryPenaltyFactor: 0.10,     // Reduce score by 10% for each duplicate category
    maxRolesPerCompany: 2            // Max recommendations allowed from a single company
  },

  // Behavioral feedback tuning
  behavioralAffinity: {
    applyBoost: 15,                 // Score boost for same company/category of applied jobs
    saveBoost: 10,                  // Score boost for same company/category of saved jobs
    viewBoost: 5,                   // Score boost for same company/category of viewed jobs
    ignorePenalty: -10,             // Penalty for same company of ignored jobs
    dismissPenalty: -20             // Penalty for same company of dismissed jobs
  }
};
