/**
 * FINAL OPTIMIZED RAG BUILDER for MR.CAR (Node 24 compatible)
 * - Extracts PDF text using pdfjs-dist (legacy build)
 * - Chunks text
 * - Embeds with OpenAI (retry-safe)
 * - Writes master RAG file
 * - Auto-handles errors, delays, and OpenAI rate limits
 */

const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
require("dotenv").config();

// ----------------------------------
// Settings
// ----------------------------------
const CHUNK_SIZE = 1200;
const BROCHURE_DIR = path.join(__dirname, "brochures");
const RAG_DIR = path.join(__dirname, ".rag_data");
const MASTER_RAG = path.join(RAG_DIR, "master_rag.json");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ----------------------------------
// Utility Sleep
// ----------------------------------
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// ----------------------------------
// Retry-safe embedding
// ----------------------------------
async function embedTextSafe(text, idx, total) {
  let attempts = 0;

  while (attempts < 5) {
    try {
      console.log(`   → Embedding chunk ${idx}/${total}`);

      const resp = await openai.embeddings.create({
        model: "text-embedding-3-large",
        input: text,
      });

      return resp.data[0].embedding;
    } catch (err) {
      attempts++;

      console.log(`   ⚠️ Embedding failed (attempt ${attempts})`);
      console.log(`     Error: ${err.message}`);

      // Backoff to avoid OpenAI throttle
      const wait = 1500 * attempts;
      console.log(`     Waiting ${wait}ms before retry...`);
      await sleep(wait);
    }
  }

  throw new Error("Embedding failed after 5 retries");
}

// ----------------------------------
// Chunking logic
// ----------------------------------
function chunkText(text) {
  const words = text.split(/\s+/);
  const chunks = [];
  let temp = [];

  for (let w of words) {
    temp.push(w);
    if (temp.join(" ").length >= CHUNK_SIZE) {
      chunks.push(temp.join(" "));
      temp = [];
    }
  }

  if (temp.length) chunks.push(temp.join(" "));
  return chunks;
}

// ----------------------------------
// PDF Text Extraction (Node Safe)
// ----------------------------------
async function extractPDFText(pdfPath) {
  console.log(`→ Loading PDF: ${path.basename(pdfPath)}`);

  // Your installation confirmed this path is correct
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const loadingTask = pdfjs.getDocument({ data });
  const pdf = await loadingTask.promise;

  let fullText = "";

  for (let i = 1; i <= pdf.numPages; i++) {
    console.log(`   • Extracting page ${i}/${pdf.numPages}`);
    const page = await pdf.getPage(i);

    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str).join(" ");
    fullText += text + "\n";
  }

  console.log(`   ✔ Extracted ${fullText.length} characters`);
  return fullText;
}

// ----------------------------------
// Process a single PDF end-to-end
// ----------------------------------
async function processPDF(pdfPath) {
  console.log("\n========================================");
  console.log("📘 Processing:", path.basename(pdfPath));

  const text = await extractPDFText(pdfPath);

  const chunks = chunkText(text);
  console.log(`📚 Total text chunks: ${chunks.length}`);

  const vectors = [];

  for (let i = 0; i < chunks.length; i++) {
    const embedding = await embedTextSafe(chunks[i], i + 1, chunks.length);

    vectors.push({
      id: `${path.basename(pdfPath)}_chunk_${i}`,
      text: chunks[i],
      embedding,
    });

    // Light delay helps avoid rate limiting
    await sleep(300);
  }

  return vectors;
}

// ----------------------------------
// Build master RAG DB
// ----------------------------------
async function buildRAG() {
  console.log("🚀 Starting RAG build...");
  console.log("📂 Reading PDFs from:", BROCHURE_DIR);

  if (!fs.existsSync(RAG_DIR)) fs.mkdirSync(RAG_DIR);

  const pdfFiles = fs.readdirSync(BROCHURE_DIR)
    .filter((f) => f.toLowerCase().endsWith(".pdf"));

  if (pdfFiles.length === 0) {
    console.log("⚠️ No PDF brochures found.");
    return;
  }

  let allVectors = [];

  // Process each PDF
  for (const file of pdfFiles) {
    const fPath = path.join(BROCHURE_DIR, file);
    const vecs = await processPDF(fPath);
    allVectors = allVectors.concat(vecs);
  }

  console.log(`\n📦 Total vectors: ${allVectors.length}`);

  fs.writeFileSync(MASTER_RAG, JSON.stringify(allVectors, null, 2), "utf8");

  console.log(`✅ Saved master RAG file at: ${MASTER_RAG}`);
  console.log("🎉 RAG build complete!");
}

// Run the builder
buildRAG();
