// models/JobEmbedding.js
// Stores vector embeddings for each job to enable semantic similarity search.
// Kept as a separate collection so we can re-embed jobs independently without
// touching the Job document, and to run MongoDB Atlas $vectorSearch natively.

const mongoose = require('mongoose');

const JobEmbeddingSchema = new mongoose.Schema({
    jobId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Job',
        required: true
    },
    // The 1536-dimensional vector from OpenAI text-embedding-3-small
    embedding: {
        type: [Number],
        required: true,
        select: false  // Never return in default queries — only fetch when needed
    },
    // The text that was embedded (for debugging and re-embedding detection)
    embeddingText: {
        type: String,
        default: ''
    },
    // Track which model and version generated the embedding
    textHash: {
        type: String,
        default: ''
    },
    model: {
        type: String,
        default: 'text-embedding-3-small'
    },
    modelVersion: {
        type: Number,
        default: 1
    },
    generatedAt: {
        type: Date,
        default: Date.now
    }
});

// Index on jobId for fast lookups during recommendation queries
JobEmbeddingSchema.index({ jobId: 1 });
JobEmbeddingSchema.index({ generatedAt: -1 });

// NOTE: The Atlas Vector Search index on the `embedding` field must be created
// manually in the MongoDB Atlas dashboard (or via Atlas CLI):
// {
//   "mappings": {
//     "dynamic": false,
//     "fields": {
//       "embedding": {
//         "type": "knnVector",
//         "dimensions": 1536,
//         "similarity": "cosine"
//       }
//     }
//   }
// }
// Index name: "job_vector_index"

module.exports = mongoose.model('JobEmbedding', JobEmbeddingSchema);
