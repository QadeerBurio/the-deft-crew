import mongoose from 'mongoose';
import { ISyncAdapter, IKnowledgeDocInput } from './adapter.interface';

export class ResumesAdapter implements ISyncAdapter {
  name = 'resumes';
  collectionName = 'resumes';

  async fetchDocuments(conn: mongoose.Connection, lastSyncedTime?: Date): Promise<any[]> {
    const db = conn.db;
    if (!db) return [];

    // Base query: only sync resumes that are set to public
    const query: Record<string, any> = {
      'settings.visibility': { $ne: 'private' }
    };

    if (lastSyncedTime) {
      query.updatedAt = { $gt: lastSyncedTime };
    }

    try {
      const docs = await db.collection(this.collectionName).find(query).toArray();
      return docs;
    } catch (err) {
      return [];
    }
  }

  mapToKnowledge(doc: any): IKnowledgeDocInput {
    const name = `${doc.personalInfo?.firstName || ''} ${doc.personalInfo?.lastName || ''}`.trim() || 'Candidate';
    const title = doc.professionalSummary?.title || 'Professional';
    
    // Extracted Skills
    let skillsList: string[] = [];
    if (doc.careerProfile?.extractedSkills) {
      const es = doc.careerProfile.extractedSkills;
      skillsList = [
        ...(es.technical || []),
        ...(es.frameworks || []),
        ...(es.languages || []),
        ...(es.tools || []),
        ...(es.databases || []),
        ...(es.cloud || [])
      ];
    } else if (Array.isArray(doc.skills)) {
      skillsList = doc.skills.map((s: any) => typeof s === 'string' ? s : s.name).filter(Boolean);
    }

    // Work Experience
    const experienceStrings = Array.isArray(doc.workExperience) 
      ? doc.workExperience.map((w: any) => `• ${w.position || 'Role'} at ${w.company || 'Company'}: ${w.description || ''}`).join('\n')
      : '';

    // Projects
    const projectsStrings = Array.isArray(doc.projects)
      ? doc.projects.map((p: any) => {
          const techStr = Array.isArray(p.technologies) ? ` (Tech: ${p.technologies.join(', ')})` : '';
          return `• Project "${p.name || 'Unnamed'}"${techStr}: ${p.description || ''}`;
        }).join('\n')
      : '';

    // Certifications
    const certsStrings = Array.isArray(doc.certifications)
      ? doc.certifications.map((c: any) => `• ${c.name || 'Certificate'} from ${c.organization || 'Organization'}`).join('\n')
      : '';

    // Languages
    const langsStrings = Array.isArray(doc.languages)
      ? doc.languages.map((l: any) => `• ${l.name || 'Language'} (${l.proficiency || 'Basic'})`).join('\n')
      : '';

    // Target Job
    const targetJobString = doc.targetJob && doc.targetJob.jobTitle
      ? `${doc.targetJob.jobTitle} (${doc.targetJob.jobType || 'Full-time'}) in ${doc.targetJob.industry || 'Any Industry'}`
      : 'None specified';

    const content = `Candidate Profile: ${name}
Target/Current Title: ${title}
Seniority: ${doc.careerProfile?.seniority || doc.professionalSummary?.experienceLevel || 'Mid Level'}
Experience: ${doc.careerProfile?.totalYearsExperience || 0} years

Professional Summary:
${doc.professionalSummary?.summary || 'No summary provided.'}

Core Skills:
${skillsList.join(', ') || 'None listed'}

Work History:
${experienceStrings || 'None listed'}

Projects:
${projectsStrings || 'None listed'}

Certifications:
${certsStrings || 'None listed'}

Languages:
${langsStrings || 'None listed'}

Target Job Goal:
${targetJobString}`;

    return {
      title: `Resume: ${name} - ${title}`,
      category: 'resumes',
      source: 'backend',
      content,
      tags: skillsList.slice(0, 15),
      status: doc.active === false ? 'archived' : 'published',
      metadata: {
        originalId: doc._id.toString(),
        userId: doc.user?.toString(),
        seniority: doc.careerProfile?.seniority,
        totalYearsExperience: doc.careerProfile?.totalYearsExperience
      }
    };
  }
}
