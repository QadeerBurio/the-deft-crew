"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PapersAdapter = exports.LecturesAdapter = exports.BooksAdapter = exports.NotesAdapter = void 0;
// Helper to safely fetch from optional backend collections
async function safeFetch(conn, collName, lastSyncedTime) {
    const db = conn.db;
    if (!db)
        return [];
    const query = {};
    if (lastSyncedTime) {
        query.updatedAt = { $gt: lastSyncedTime };
    }
    try {
        const list = await db.listCollections({ name: collName }).toArray();
        if (list.length === 0)
            return []; // Collection doesn't exist yet
        return await db.collection(collName).find(query).toArray();
    }
    catch (err) {
        return [];
    }
}
class NotesAdapter {
    name = 'notes';
    collectionName = 'notes';
    async fetchDocuments(conn, lastSyncedTime) {
        return safeFetch(conn, this.collectionName, lastSyncedTime);
    }
    mapToKnowledge(doc) {
        return {
            title: doc.title || 'Untitled Note',
            category: 'notes',
            source: 'backend',
            content: `Note Title: ${doc.title || 'Untitled Note'}\nSubject: ${doc.subject || 'N/A'}\nContent:\n${doc.content || ''}`,
            tags: doc.tags || [],
            status: 'published',
            metadata: {
                originalId: doc._id.toString()
            }
        };
    }
}
exports.NotesAdapter = NotesAdapter;
class BooksAdapter {
    name = 'books';
    collectionName = 'books';
    async fetchDocuments(conn, lastSyncedTime) {
        return safeFetch(conn, this.collectionName, lastSyncedTime);
    }
    mapToKnowledge(doc) {
        return {
            title: doc.title || 'Untitled Book',
            category: 'books',
            source: 'backend',
            content: `Book Title: ${doc.title || 'Untitled Book'}\nAuthor: ${doc.author || 'N/A'}\nDescription: ${doc.description || ''}`,
            tags: doc.genre ? [doc.genre] : [],
            status: 'published',
            metadata: {
                originalId: doc._id.toString()
            }
        };
    }
}
exports.BooksAdapter = BooksAdapter;
class LecturesAdapter {
    name = 'lectures';
    collectionName = 'lectures';
    async fetchDocuments(conn, lastSyncedTime) {
        return safeFetch(conn, this.collectionName, lastSyncedTime);
    }
    mapToKnowledge(doc) {
        return {
            title: doc.title || 'Untitled Lecture',
            category: 'lectures',
            source: 'backend',
            content: `Lecture: ${doc.title || 'Untitled Lecture'}\nCourse: ${doc.course || 'N/A'}\nDuration: ${doc.duration || 'N/A'}\nContent Summary: ${doc.summary || ''}`,
            tags: [],
            status: 'published',
            metadata: {
                originalId: doc._id.toString()
            }
        };
    }
}
exports.LecturesAdapter = LecturesAdapter;
class PapersAdapter {
    name = 'pastPapers';
    collectionName = 'pastpapers';
    async fetchDocuments(conn, lastSyncedTime) {
        return safeFetch(conn, this.collectionName, lastSyncedTime);
    }
    mapToKnowledge(doc) {
        return {
            title: doc.title || 'Untitled Past Paper',
            category: 'pastPapers',
            source: 'backend',
            content: `Past Paper: ${doc.title || 'Untitled Past Paper'}\nSubject: ${doc.subject || 'N/A'}\nYear: ${doc.year || 'N/A'}\nSemester: ${doc.semester || 'N/A'}`,
            tags: [doc.subject].filter(Boolean),
            status: 'published',
            metadata: {
                originalId: doc._id.toString()
            }
        };
    }
}
exports.PapersAdapter = PapersAdapter;
//# sourceMappingURL=skeleton.adapters.js.map