"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobsAdapter = void 0;
class JobsAdapter {
    name = 'jobs';
    collectionName = 'jobs';
    async fetchDocuments(conn, lastSyncedTime) {
        const db = conn.db;
        if (!db)
            return [];
        const query = {};
        if (lastSyncedTime) {
            query.updatedAt = { $gt: lastSyncedTime };
        }
        try {
            const docs = await db.collection(this.collectionName).find(query).toArray();
            return docs;
        }
        catch (err) {
            return [];
        }
    }
    mapToKnowledge(doc) {
        const reqs = Array.isArray(doc.requirements) ? doc.requirements.map((r) => `• ${r}`).join('\n') : '';
        const resps = Array.isArray(doc.responsibilities) ? doc.responsibilities.map((r) => `• ${r}`).join('\n') : '';
        const benefits = Array.isArray(doc.benefits) ? doc.benefits.map((b) => `• ${b}`).join('\n') : '';
        const content = `Job Title: ${doc.title || 'Untitled Job'}
Company: ${doc.companyName || 'The Deft Crew (TDC)'}
Department: ${doc.department || 'N/A'}
Category: ${doc.category || 'Technology'}
Location: ${doc.location || 'Remote'} (${doc.locationType || 'Remote'})
Type: ${doc.type || 'Full-time'}
Salary: ${doc.salary || 'N/A'} (${doc.currency || 'USD'})
Experience: ${doc.experienceLevel || 'Entry Level'} (Min: ${doc.minExperience || 0} years)
Education: ${doc.education || 'Not Specified'}

Description:
${doc.description || 'No description provided.'}

Requirements:
${reqs || 'None'}

Responsibilities:
${resps || 'None'}

Benefits:
${benefits || 'None'}

Contact Email: ${doc.email || 'N/A'}`;
        return {
            title: `${doc.title || 'Untitled Job'} at ${doc.companyName || 'TDC'}`,
            category: 'jobs',
            source: 'backend',
            content,
            tags: Array.isArray(doc.skills) ? doc.skills : [],
            status: doc.active === false ? 'archived' : 'published',
            metadata: {
                originalId: doc._id.toString(),
                companyName: doc.companyName,
                department: doc.department,
                category: doc.category,
                location: doc.location,
                locationType: doc.locationType,
                type: doc.type,
                salary: doc.salary,
                experienceLevel: doc.experienceLevel,
                minExperience: doc.minExperience,
                education: doc.education
            }
        };
    }
}
exports.JobsAdapter = JobsAdapter;
//# sourceMappingURL=jobs.adapter.js.map