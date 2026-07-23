"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SlidersAdapter = void 0;
class SlidersAdapter {
    name = 'sliders';
    collectionName = 'sliders';
    async fetchDocuments(conn, _lastSyncedTime) {
        const db = conn.db;
        if (!db)
            return [];
        const query = {};
        // Note: Slider schema doesn't have an updatedAt field, but has default timestamp behaviors sometimes, let's pull all
        try {
            const docs = await db.collection(this.collectionName).find(query).toArray();
            return docs;
        }
        catch (err) {
            return [];
        }
    }
    mapToKnowledge(doc) {
        const isPromo = doc.type === 'offer';
        const content = `${isPromo ? 'App Slide Offer' : 'App Banner Slide'}: ${doc.title || 'Untitled Banner'}
Description: ${doc.description || 'No details.'}
Category: ${doc.category || 'N/A'}
Discount: ${doc.discountPercentage || 0}% Off
Location: ${doc.location || 'N/A'}
Link URL: ${doc.link || 'N/A'}
Redeem Steps: ${doc.redeemInstructions || 'N/A'}`;
        return {
            title: doc.title || 'Untitled Banner Slide',
            category: 'sliders',
            source: 'backend',
            content,
            tags: [doc.type || 'slider'],
            status: doc.active === false ? 'archived' : 'published',
            metadata: {
                originalId: doc._id.toString(),
                type: doc.type,
                link: doc.link,
                category: doc.category,
                discountPercentage: doc.discountPercentage,
                location: doc.location
            }
        };
    }
}
exports.SlidersAdapter = SlidersAdapter;
//# sourceMappingURL=sliders.adapter.js.map