"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ragService = exports.RAGService = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const db_1 = require("../config/db");
const retrieval_service_1 = require("./retrieval.service");
const prompt_service_1 = require("./prompt.service");
const openai_service_1 = require("./openai.service");
const intentClassifier_1 = require("./intentClassifier");
const logger_1 = require("../config/logger");
/**
 * Serializes a raw resume document to a clean text representation for RAG context
 */
function serializeResumeForRAG(resume) {
    const parts = [];
    const name = `${resume.personalInfo?.firstName || ''} ${resume.personalInfo?.lastName || ''}`.trim();
    if (name)
        parts.push(`Candidate Name: ${name}`);
    const title = resume.professionalSummary?.title || '';
    if (title)
        parts.push(`Current/Target Title: ${title}`);
    const summary = resume.professionalSummary?.summary || '';
    if (summary)
        parts.push(`Professional Summary: ${summary}`);
    const cp = resume.careerProfile;
    if (cp) {
        if (cp.seniority)
            parts.push(`Seniority Level: ${cp.seniority}`);
        if (cp.totalYearsExperience)
            parts.push(`Years of Experience: ${cp.totalYearsExperience} years`);
        if (cp.domainExpertise?.length)
            parts.push(`Domain Expertise: ${cp.domainExpertise.join(', ')}`);
        const skills = cp.extractedSkills || {};
        const techSkills = [
            ...(skills.technical || []),
            ...(skills.frameworks || []),
            ...(skills.languages || []),
            ...(skills.tools || []),
            ...(skills.databases || []),
            ...(skills.cloud || [])
        ];
        if (techSkills.length)
            parts.push(`Technical Skills: ${techSkills.slice(0, 20).join(', ')}`);
        if (skills.softSkills?.length)
            parts.push(`Soft Skills: ${skills.softSkills.join(', ')}`);
        if (cp.preferredRoles?.length)
            parts.push(`Preferred Roles: ${cp.preferredRoles.join(', ')}`);
        if (cp.preferredLocations?.length)
            parts.push(`Preferred Locations: ${cp.preferredLocations.join(', ')}`);
    }
    else {
        const rawSkills = Array.isArray(resume.skills)
            ? resume.skills.map((s) => typeof s === 'string' ? s : s.name).filter(Boolean)
            : [];
        if (rawSkills.length)
            parts.push(`Skills: ${rawSkills.join(', ')}`);
    }
    if (Array.isArray(resume.workExperience) && resume.workExperience.length > 0) {
        const expStrings = resume.workExperience.map((w) => {
            const dateRange = `${w.startDate ? new Date(w.startDate).getFullYear() : ''} - ${w.current ? 'Present' : (w.endDate ? new Date(w.endDate).getFullYear() : '')}`;
            return `${w.position || 'Developer'} at ${w.company || 'Company'} (${dateRange}): ${w.description || ''}`;
        });
        parts.push(`Work History:\n- ${expStrings.join('\n- ')}`);
    }
    if (Array.isArray(resume.education) && resume.education.length > 0) {
        const eduStrings = resume.education.map((e) => `${e.degree || 'Degree'} from ${e.institution || 'University'}`);
        parts.push(`Education:\n- ${eduStrings.join('\n- ')}`);
    }
    if (Array.isArray(resume.projects) && resume.projects.length > 0) {
        const projStrings = resume.projects.map((p) => {
            const techStr = Array.isArray(p.technologies) ? ` (Tech: ${p.technologies.join(', ')})` : '';
            return `${p.name || 'Project'}${techStr}: ${p.description || ''}`;
        });
        parts.push(`Projects:\n- ${projStrings.join('\n- ')}`);
    }
    if (Array.isArray(resume.certifications) && resume.certifications.length > 0) {
        const certStrings = resume.certifications.map((c) => `${c.name || 'Certificate'} from ${c.organization || 'Organization'}`);
        parts.push(`Certifications:\n- ${certStrings.join('\n- ')}`);
    }
    if (Array.isArray(resume.languages) && resume.languages.length > 0) {
        const langStrings = resume.languages.map((l) => `${l.name || 'Language'} (${l.proficiency || 'Basic'})`);
        parts.push(`Languages: ${langStrings.join(', ')}`);
    }
    if (resume.targetJob && resume.targetJob.jobTitle) {
        parts.push(`Target Job Interest: ${resume.targetJob.jobTitle} (${resume.targetJob.jobType || 'Full-time'}) in ${resume.targetJob.industry || 'Any Industry'}`);
    }
    return parts.join('\n');
}
class RAGService {
    /**
     * Orchestrates the RAG flow: gets matching contexts, injects them into prompts,
     * requests chat completions, and aggregates performance details.
     */
    async handleUserMessage(message, category, historyMessages = [], userInfo) {
        const startTime = Date.now();
        // 1. Retrieve matching context blocks from database directly and Vector Store
        const intent = await intentClassifier_1.intentClassifier.classifyIntent(message);
        const directContext = await retrieval_service_1.retrievalService.retrieveDirectDatabaseContext(intent, message, category);
        const retrievalResult = await retrieval_service_1.retrievalService.retrieveRelevantContext(message, category);
        const retrievalLatencyMs = Date.now() - startTime;
        const combinedContext = [directContext, retrievalResult.contextText].filter(Boolean).join('\n\n');
        // 2. Build contextual prompts with user identity prefix
        let composedPrompt = prompt_service_1.promptService.getSystemInstructions(combinedContext);
        // Adjust instructions if Career Coach mode is enabled
        if (category === 'CAREER_COACH') {
            composedPrompt = `[Career Coach Mode Enabled]
You are acting as the user's personal Career Coach. 
Answer their career-related questions, suggest resume enhancements, guide them on key skills, and provide realistic advice based on their profile.
Be encouraging, analytical, and professional.
-----------------------\n` + composedPrompt;
        }
        if (userInfo) {
            composedPrompt = `[User Identity Profile]
Name: ${userInfo.name}
Role: ${userInfo.role}
Is Guest: ${userInfo.isGuest}
${userInfo.university ? `University Reference ID: ${userInfo.university}` : ''}
Greet the user by their name if they greet you or if context is appropriate.
-----------------------
\n` + composedPrompt;
        }
        // 3. Dynamically inject the user's primary resume context if logged in
        if (userInfo && !userInfo.isGuest) {
            try {
                const db = db_1.backendDbConnection.db;
                if (db) {
                    let resume = await db.collection('resumes').findOne({
                        user: new mongoose_1.default.Types.ObjectId(userInfo.id),
                        isPrimary: true
                    });
                    if (!resume) {
                        resume = await db.collection('resumes').findOne({ user: new mongoose_1.default.Types.ObjectId(userInfo.id) }, { sort: { updatedAt: -1 } });
                    }
                    if (resume) {
                        const resumeText = serializeResumeForRAG(resume);
                        composedPrompt += `\n\n[Candidate Career Profile (Resume Context)]
Use this information about the user to personalize your responses and give relevant career or profile guidance:
${resumeText}
[End of Candidate Career Profile]`;
                    }
                }
            }
            catch (err) {
                logger_1.logger.error('Failed to retrieve resume context for RAG:', err.message);
            }
        }
        // 4. Dispatch queries to OpenAI completions (with history and tool execution support)
        const completionResult = await openai_service_1.openaiService.getChatCompletion(composedPrompt, message, historyMessages);
        const totalLatencyMs = Date.now() - startTime;
        logger_1.logger.info(`RAG Pipeline completed. Context chunks retrieved: ${retrievalResult.sourceDocuments.length}. ` +
            `Performance metrics: [Overall: ${totalLatencyMs}ms, Retrieval: ${retrievalLatencyMs}ms, OpenAI: ${completionResult.latencyMs}ms]`);
        return {
            reply: completionResult.reply,
            latencyMs: totalLatencyMs,
            openaiLatencyMs: completionResult.latencyMs,
            retrievalLatencyMs,
            usage: completionResult.usage,
            modelUsed: completionResult.modelUsed,
            sourceDocuments: retrievalResult.sourceDocuments,
        };
    }
}
exports.RAGService = RAGService;
exports.ragService = new RAGService();
exports.default = exports.ragService;
//# sourceMappingURL=rag.service.js.map