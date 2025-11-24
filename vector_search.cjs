const dot = (a, b) => a.reduce((sum, val, i) => sum + val * b[i], 0);

const magnitude = (v) => Math.sqrt(dot(v, v));

function cosineSimilarity(a, b) {
  return dot(a, b) / (magnitude(a) * magnitude(b));
}

/**
 * Finds the top N relevant chunks from RAG data
 */
function findRelevantChunks(queryEmbedding, ragData, topN = 5) {
  if (!ragData || ragData.length === 0) return [];

  let scored = [];

  for (let item of ragData) {
    if (!item.embedding) continue;

    const score = cosineSimilarity(queryEmbedding, item.embedding);
    scored.push({ ...item, score });
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, topN);
}

module.exports = { findRelevantChunks };
