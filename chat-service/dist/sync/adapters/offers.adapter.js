"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OffersAdapter = void 0;
class OffersAdapter {
    name = 'offers';
    collectionName = 'offers';
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
        const content = `Offer Title: ${doc.title || 'Untitled Offer'}
Category: ${doc.category || 'Others'}
Discount: ${doc.discountPercentage || 0}% Off
Location: ${doc.location || 'N/A'} (Online: ${doc.isOnline ? 'Yes' : 'No'}, In-Store: ${doc.isInStore ? 'Yes' : 'No'})
Description: ${doc.description || 'No description provided.'}
Redeem Instructions: ${doc.redeemInstructions || 'Follow checkout instructions in the TDC app.'}`;
        return {
            title: doc.title || 'Untitled Offer',
            category: 'offers',
            source: 'backend',
            content,
            tags: doc.category ? [doc.category] : [],
            status: 'published', // Offers don't have active field in schema, but we can standardise
            metadata: {
                originalId: doc._id.toString(),
                discountPercentage: doc.discountPercentage,
                category: doc.category,
                location: doc.location,
                isOnline: doc.isOnline,
                isInStore: doc.isInStore,
                brandId: doc.brand ? doc.brand.toString() : undefined,
                universityId: doc.university ? doc.university.toString() : undefined
            }
        };
    }
}
exports.OffersAdapter = OffersAdapter;
//# sourceMappingURL=offers.adapter.js.map