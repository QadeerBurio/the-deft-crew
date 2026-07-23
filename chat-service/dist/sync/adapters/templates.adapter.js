"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TemplatesAdapter = void 0;
class TemplatesAdapter {
    name = 'templates';
    collectionName = 'templates';
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
        const bestForStr = Array.isArray(doc.bestFor) ? doc.bestFor.join(', ') : 'All';
        const industriesStr = Array.isArray(doc.industries) ? doc.industries.join(', ') : 'All';
        const experienceLevelStr = Array.isArray(doc.experienceLevel) ? doc.experienceLevel.join(', ') : 'All';
        const content = `Resume Template: ${doc.name || 'Untitled Template'} (ID: ${doc.id || 'N/A'})
Category: ${doc.category || 'modern'}
Layout: ${doc.layout || 'single-column'}
Description: ${doc.description || 'No description provided.'}
Best Suited For: ${bestForStr}
Target Industries: ${industriesStr}
Target Experience: ${experienceLevelStr}
Popularity Index: ${doc.popularity || 0} clicks`;
        return {
            title: `${doc.name || 'Untitled'} Resume Template`,
            category: 'templates',
            source: 'backend',
            content,
            tags: doc.category ? [doc.category, doc.layout].filter(Boolean) : [],
            status: doc.isActive === false ? 'archived' : 'published',
            metadata: {
                originalId: doc._id.toString(),
                templateId: doc.id,
                category: doc.category,
                layout: doc.layout,
                popularity: doc.popularity,
                bestFor: doc.bestFor,
                industries: doc.industries
            }
        };
    }
}
exports.TemplatesAdapter = TemplatesAdapter;
//# sourceMappingURL=templates.adapter.js.map