"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UniversitiesAdapter = void 0;
class UniversitiesAdapter {
    name = 'universities';
    collectionName = 'universities';
    async fetchDocuments(conn, _lastSyncedTime) {
        const db = conn.db;
        if (!db)
            return [];
        const query = {};
        // Note: University schema has no timestamps, so we fetch all each time for simplicity
        try {
            const docs = await db.collection(this.collectionName).find(query).toArray();
            return docs;
        }
        catch (err) {
            return [];
        }
    }
    mapToKnowledge(doc) {
        const content = `University Name: ${doc.name || 'Unknown University'}
This university is registered with The Deft Crew platform for student verification and exclusive brand offers.`;
        return {
            title: doc.name || 'Unknown University',
            category: 'universities',
            source: 'backend',
            content,
            tags: ['university'],
            status: 'published',
            metadata: {
                originalId: doc._id.toString()
            }
        };
    }
}
exports.UniversitiesAdapter = UniversitiesAdapter;
//# sourceMappingURL=universities.adapter.js.map