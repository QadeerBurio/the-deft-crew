// services/resumeIntelligenceService.js
const OpenAI = require('openai');

let openai;
function getOpenAI() {
  if (!openai) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

/**
 * Optimizes a parsed resume JSON with the Master AI Resume Intelligence Engine.
 * @param {Object} parsedData 
 * @returns {Promise<Object>} optimizedResumeJSON
 */
async function optimizeParsedResume(parsedData) {
  try {
    console.log('🧠 Master AI Resume Intelligence Engine: Running pipeline...');
    
    if (!process.env.OPENAI_API_KEY) {
      console.log('⚠️ [Resume Intelligence] OpenAI API Key missing. Skipping optimization.');
      return {
        ...parsedData,
        careerLevel: 'Mid Level',
        industry: 'General',
        targetRole: parsedData.professionalSummary?.title || 'Professional',
        professionalBrand: 'Professional Branding Draft',
        personalBranding: {
          professionalHeadline: parsedData.professionalSummary?.title || 'Professional',
          personalBrandStatement: '',
          coreValueProposition: '',
          professionalIdentity: ''
        },
        careerHighlights: [],
        coreCompetencies: [],
        atsKeywords: [],
        missingKeywords: [],
        keywordMatchPercentage: 50,
        resumeScores: {
          atsScore: 50,
          recruiterScore: 50,
          contentQuality: 50,
          keywordStrength: 50,
          formattingScore: 50,
          impactScore: 50,
          overallHiringScore: 50
        },
        hrScorecard: {
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
        hiringDecision: {
          hrShortlist: { status: 'MAYBE', reason: 'Basic profile review required.' },
          hiringManagerInterview: { status: 'MAYBE', reason: 'Needs portfolio and technical screening.' },
          departmentHeadApprove: { status: 'MAYBE', reason: 'Requires team fit evaluation.' }
        },
        industryBenchmarking: {
          percentileRank: 'Average',
          rankExplanation: 'Standard profile matching minimum criteria.'
        },
        prioritizedImprovementPlan: [
          {
            priority: 'High',
            recommendation: 'Add OpenAI API Key to environmental configuration.',
            why: 'To enable full AI resume optimization and scoring pipelines.',
            impact: { business: 'Medium', hr: 'High', ats: 'High', hiring: 'High' }
          }
        ],
        missingSkills: [],
        strengths: [],
        weaknesses: [],
        optimizedSummary: parsedData.professionalSummary?.summary || '',
        optimizedExperience: parsedData.workExperience || [],
        optimizedProjects: parsedData.projects || [],
        optimizedSkills: parsedData.skills || [],
        hrRecommendations: ['Add OpenAI API key to unlock full AI enhancement.']
      };
    }

    const client = getOpenAI();
    const systemPrompt = `You are the World-Class AI Resume Intelligence Engine (HR + ATS + Executive Resume Writer).
You combine the expertise of an Executive Resume Writer (30+ Years), Fortune 500 Hiring Manager, Technical Recruiter, Senior HR Director, ATS Optimization Expert, Career Coach, LinkedIn Branding Consultant, and Organizational Psychologist.

Your mission is to maximize interview probability while remaining 100% truthful.
Your job is NOT to summarize, NOT to paraphrase, and NOT to decorate language.

---
THINKING PROCESS:
Silently perform these stages before generating output:
Stage 1: Understand the candidate (Industry, Career Level, Strengths/Weaknesses, technical/soft skill boundaries).
Stage 2: Think like ATS Software (Industry keyword density, missing keywords, parsing risks).
Stage 3: Think like HR (Spend only 6 seconds reviewing. Ask: Would I shortlist? Why? Why not?).
Stage 4: Think like Hiring Manager (Problem solver? Value creator? Trust factor?).
Stage 5: Think like Department Manager (Leadership, ownership, growth potential).

---
QUALITY & WRITING RULES:
1. ONLY improve language, structure, clarity, readability, professionalism, and business impact.
2. NEVER hallucinate or invent fake jobs, fake companies, fake dates, fake GPAs, fake certification names, or fake metrics.
3. PROFESSIONAL SUMMARY: Rewrite completely. Highlight experience, specialization, strengths, competitive advantage, and business value. Answer: "Why should I interview this person?". No markdown, no bold text.
4. EXPERIENCE BULLETS: Rewrite every bullet point. Every bullet must follow: Action -> Impact -> Business Value. Use strong executive verbs (Designed, Created, Built, Optimized, Implemented, Generated, Improved, Architected, Engineered, etc.). Include original factual numbers if present, but NEVER fabricate metrics.
5. PROJECTS: Rewrite projects to show Problem, Approach, Role, Technologies, Impact, and Outcome.
6. SKILLS: Group and categorize skills logically.
7. SCORES & DECISIONS: Assess all categories honestly and output detailed scores, HR scorecard, hiring manager interview status (YES/MAYBE/NO), and department head decisions with logical reasons.
8. BENCHMARKING: Benchmark the candidate's resume (percentile rank and why).
9. IMPROVEMENT PLAN: Generate prioritized recommendations (Critical, High, Medium, Nice to Have) with specific explanations and impacts.

---
OUTPUT JSON SCHEMA:
Provide the response in the exact JSON format defined below (do not wrap in markdown \`\`\`json blocks):

{
  "careerLevel": "Detected career level (Student, Fresh Graduate, Entry Level, Associate, Mid-Level, Senior, Lead, Manager, Director, Executive)",
  "industry": "Detected industry area",
  "targetRole": "Candidate's strongest target role title",
  "professionalBrand": "A 1-sentence tagline describing their professional branding statement",
  "personalBranding": {
    "professionalHeadline": "Recruiter-ready headline (like a LinkedIn headline)",
    "personalBrandStatement": "A 2-sentence brand statement summarizing their value proposition",
    "coreValueProposition": "A short summary of their unique core value proposition",
    "professionalIdentity": "A brief description of their professional identity archetype"
  },
  "careerHighlights": ["2-3 key achievements or milestones extracted from their experience"],
  "coreCompetencies": ["8-15 core competency keyword areas directly supported by the resume"],
  "atsKeywords": ["6-10 keywords that are highly relevant to their detected industry and role"],
  "missingKeywords": ["4-6 keywords expected in their industry that are currently missing from the resume"],
  "keywordMatchPercentage": (integer 0-100),
  "resumeScores": {
    "atsScore": (integer 0-100),
    "recruiterScore": (integer 0-100),
    "contentQuality": (integer 0-100),
    "keywordStrength": (integer 0-100),
    "formattingScore": (integer 0-100),
    "impactScore": (integer 0-100),
    "overallHiringScore": (integer 0-100)
  },
  "hrScorecard": {
    "professionalSummaryScore": (integer 0-10),
    "experienceScore": (integer 0-30),
    "projectsScore": (integer 0-15),
    "educationScore": (integer 0-10),
    "skillsScore": (integer 0-10),
    "achievementsScore": (integer 0-10),
    "atsScore": (integer 0-10),
    "formattingScore": (integer 0-5),
    "professionalBrandingScore": (integer 0-5),
    "overallScore": (integer 0-100)
  },
  "hiringDecision": {
    "hrShortlist": { "status": "YES/MAYBE/NO", "reason": "Reason for shortlist decision" },
    "hiringManagerInterview": { "status": "YES/MAYBE/NO", "reason": "Reason for interview decision" },
    "departmentHeadApprove": { "status": "YES/MAYBE/NO", "reason": "Reason for approval decision" }
  },
  "industryBenchmarking": {
    "percentileRank": "Percentile bracket (e.g. Top 10%, Top 25%, Top 50%, Average)",
    "rankExplanation": "Detailed explanation of where this resume ranks and why relative to peers"
  },
  "prioritizedImprovementPlan": [
    {
      "priority": "Critical/High/Medium/Nice to Have",
      "recommendation": "Concrete recommendation details",
      "why": "Explanation of why it is needed",
      "impact": {
        "business": "Impact on business perception",
        "hr": "Impact on HR screening",
        "ats": "Impact on ATS searchability",
        "hiring": "Impact on final hiring decision"
      }
    }
  ],
  "missingSkills": ["3-5 skills they should learn"],
  "strengths": ["2-3 clear strengths of the content"],
  "weaknesses": ["2-3 clear areas of weakness"],
  "optimizedSummary": "Completely rewritten, professional summary paragraph (no markdown, no bold text).",
  "optimizedExperience": [
    {
      "company": "Company Name",
      "position": "Role Title",
      "location": "Location",
      "startDate": "Start Date",
      "endDate": "End Date",
      "current": (boolean),
      "description": "Comprehensive rewritten description following the STAR method. Each sentence must start with a strong action verb and communicate direct business value/impact. Preserve original metrics but do not invent fake ones."
    }
  ],
  "optimizedProjects": [
    {
      "name": "Project Name",
      "description": "Problem-Approach-Technologies-Impact structured description.",
      "technologies": ["Array of technologies used"],
      "startDate": "Start Date",
      "endDate": "End Date",
      "url": "URL if any"
    }
  ],
  "optimizedSkills": [
    {
      "name": "Skill Name",
      "level": "Expertise level (Beginner, Intermediate, Expert)",
      "category": "Skill category (e.g., Programming Languages, Frameworks, Software & Tools, Soft Skills, Design Skills, Business Skills)"
    }
  ],
  "hrRecommendations": ["3-5 concrete actionable pieces of advice from an HR manager to improve their profile"]
}`;

    const userPrompt = `Here is the parsed resume JSON to optimize:\n\n${JSON.stringify(parsedData, null, 2)}`;

    const response = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      response_format: { type: "json_object" },
      temperature: 0.3
    });

    const resultText = response.choices[0]?.message?.content?.trim() || '{}';
    const optimizedResult = JSON.parse(resultText);

    console.log('✅ Master AI Resume Intelligence Engine: Optimization completed');
    return optimizedResult;

  } catch (error) {
    console.error('❌ Master AI Resume Intelligence Engine error:', error);
    // Return graceful fallback matching schema
    return {
      ...parsedData,
      careerLevel: 'Mid Level',
      industry: 'General',
      targetRole: parsedData.professionalSummary?.title || 'Professional',
      professionalBrand: 'Professional Branding Draft',
      personalBranding: {
        professionalHeadline: parsedData.professionalSummary?.title || 'Professional',
        personalBrandStatement: '',
        coreValueProposition: '',
        professionalIdentity: ''
      },
      careerHighlights: [],
      coreCompetencies: [],
      atsKeywords: [],
      missingKeywords: [],
      keywordMatchPercentage: 40,
      resumeScores: {
        atsScore: 40,
        recruiterScore: 40,
        contentQuality: 40,
        keywordStrength: 40,
        formattingScore: 40,
        impactScore: 40,
        overallHiringScore: 40
      },
      hrScorecard: {
        professionalSummaryScore: 4,
        experienceScore: 12,
        projectsScore: 6,
        educationScore: 4,
        skillsScore: 4,
        achievementsScore: 4,
        atsScore: 4,
        formattingScore: 2,
        professionalBrandingScore: 1,
        overallScore: 40
      },
      hiringDecision: {
        hrShortlist: { status: 'MAYBE', reason: 'Error parsing profile.' },
        hiringManagerInterview: { status: 'MAYBE', reason: 'Error parsing profile.' },
        departmentHeadApprove: { status: 'MAYBE', reason: 'Error parsing profile.' }
      },
      industryBenchmarking: {
        percentileRank: 'Average',
        rankExplanation: 'Standard profile fallback due to service error.'
      },
      prioritizedImprovementPlan: [
        {
          priority: 'High',
          recommendation: 'Fix system service error: ' + error.message,
          why: 'To enable full AI resume optimization and scoring pipelines.',
          impact: { business: 'Medium', hr: 'High', ats: 'High', hiring: 'High' }
        }
      ],
      missingSkills: [],
      strengths: [],
      weaknesses: [],
      optimizedSummary: parsedData.professionalSummary?.summary || '',
      optimizedExperience: parsedData.workExperience || [],
      optimizedProjects: parsedData.projects || [],
      optimizedSkills: parsedData.skills || [],
      hrRecommendations: [`Failed to run AI enhancement: ${error.message}`]
    };
  }
}

module.exports = {
  optimizeParsedResume
};
