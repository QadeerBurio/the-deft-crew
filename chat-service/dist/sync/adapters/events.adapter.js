"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventsAdapter = void 0;
class EventsAdapter {
    name = 'events';
    collectionName = 'events';
    async fetchDocuments(conn, lastSyncedTime) {
        const db = conn.db;
        if (!db)
            return [];
        const query = {};
        if (lastSyncedTime) {
            query.createdAt = { $gt: lastSyncedTime }; // Note: Event model schema does not have timestamps, only createdAt
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
        const content = `Event Title: ${doc.title || 'Untitled Event'}
Organizer: ${doc.organizer || 'N/A'}
Type: ${doc.type || 'Generic Event'}
Date: ${doc.date || 'TBA'}
Location: ${doc.location || 'Online/Venue TBD'} (City: ${doc.city || 'N/A'})
Description: ${doc.description || 'No description provided.'}
Prize Pool: ${doc.prize || 'TBD'}
Registration Deadline: ${doc.deadline || 'Limited spots'}
Team Structure: ${doc.teamSize || '1-4 Members'}
Contact Details: ${doc.contact || 'N/A'}`;
        return {
            title: doc.title || 'Untitled Event',
            category: 'events',
            source: 'backend',
            content,
            tags: doc.type ? [doc.type, doc.city] : [doc.city].filter(Boolean),
            status: 'published',
            metadata: {
                originalId: doc._id.toString(),
                organizer: doc.organizer,
                city: doc.city,
                type: doc.type,
                prize: doc.prize,
                deadline: doc.deadline,
                location: doc.location,
                date: doc.date,
                teamSize: doc.teamSize,
                creatorEmail: doc.creatorEmail,
                creatorName: doc.creatorName
            }
        };
    }
}
exports.EventsAdapter = EventsAdapter;
//# sourceMappingURL=events.adapter.js.map