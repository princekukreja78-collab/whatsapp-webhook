const fs = require("fs");
const path = require("path");

const MASTER_RAG = path.join(__dirname, ".rag_data", "master_rag.json");

let vectorDB = [];

function loadRAG() {
  try {
    if (fs.existsSync(MASTER_RAG)) {
      vectorDB = JSON.parse(fs.readFileSync(MASTER_RAG, "utf8"));
      console.log(`📚 RAG Loaded: ${vectorDB.length} chunks`);
    } else {
      console.log("⚠️ master_rag.json not found — using empty RAG");
      vectorDB = [];
    }
  } catch (err) {
    console.error("❌ Failed loading master_rag.json:", err);
  }
}

// Load immediately
loadRAG();

// Reload every 30 seconds
setInterval(loadRAG, 30000);

function getRAG() {
  return vectorDB;
}

module.exports = { getRAG };
