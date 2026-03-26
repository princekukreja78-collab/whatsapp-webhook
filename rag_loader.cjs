const fs = require("fs");
const path = require("path");

const MASTER_RAG = path.join(__dirname, ".rag_data", "master_rag.json");

let vectorDB = [];

let _ragLastMtime = 0;

function loadRAG(force = false) {
  try {
    if (!fs.existsSync(MASTER_RAG)) {
      if (!vectorDB.length) console.log("master_rag.json not found — using empty RAG");
      vectorDB = [];
      return;
    }
    const stat = fs.statSync(MASTER_RAG);
    const mtime = stat.mtimeMs;
    // Skip reload if file hasn't changed (unless forced)
    if (!force && mtime === _ragLastMtime && vectorDB.length > 0) return;
    _ragLastMtime = mtime;
    vectorDB = JSON.parse(fs.readFileSync(MASTER_RAG, "utf8"));
    console.log(`RAG Loaded: ${vectorDB.length} chunks`);
  } catch (err) {
    console.error("Failed loading master_rag.json:", err.message);
  }
}

// Load immediately
loadRAG(true);

// Check for changes every 5 minutes (only reloads if file modified)
setInterval(loadRAG, 5 * 60 * 1000);

function getRAG() {
  return vectorDB;
}

module.exports = { getRAG };
