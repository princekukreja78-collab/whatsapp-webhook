const fs = require("fs");
const path = require("path");
const ragProcess = require('./rag_process.cjs');

const uploadsDir = path.join(__dirname, ".rag_uploads");
const dataDir = path.join(__dirname, ".rag_data");
const masterFile = path.join(dataDir, "master_rag.json");

function mergeVectors() {
  const files = fs.readdirSync(dataDir).filter(f => f.endsWith(".vectors.json"));
  let merged = [];

  for (let f of files) {
    const vec = JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf8"));
    merged = merged.concat(vec);
  }

  fs.writeFileSync(masterFile, JSON.stringify(merged, null, 2), "utf8");
  console.log(`🔄 Merged ${files.length} vector files → master_rag.json`);
  console.log(`📚 Total chunks in master: ${merged.length}`);
}

console.log("👀 Watching for PDFs in:", uploadsDir);

fs.watch(uploadsDir, async (eventType, filename) => {
  if (!filename) return;
  if (!filename.toLowerCase().endsWith(".pdf")) return;

  const fullPath = path.join(uploadsDir, filename);
  if (!fs.existsSync(fullPath)) return;

  console.log("📥 New PDF detected:", filename);

  try {
    const vectorPath = await processPDF(fullPath);
    console.log("📦 Vector JSON created:", vectorPath);
    mergeVectors();
  } catch (e) {
    console.error("❌ Error processing PDF:", e);
  }
});
