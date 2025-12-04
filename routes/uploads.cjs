const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const csvParse = require('csv-parse/lib/sync');

const router = express.Router();
const upload = multer({ dest: path.join(__dirname, '..', 'tmp_uploads') });

// helper: write leads file
function writeLeads(leads){
  const leadsPath = path.join(__dirname, '..', 'crm_leads.json');
  fs.writeFileSync(leadsPath, JSON.stringify(leads, null, 2), 'utf8');
}

// POST /api/uploads/csv
router.post('/csv', upload.single('csv'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok:false, error:'no_file' });
    const csvText = fs.readFileSync(req.file.path, 'utf8');
    // parse CSV expecting header row: ID,Name,Phone,Status,Timestamp (flexible)
    const records = csvParse(csvText, { columns: true, skip_empty_lines: true });
    // normalize
    const leads = records.map(r => ({
      id: r.ID || r.id || r.lead_id || '',
      name: r.Name || r.name || '',
      phone: r.Phone || r.phone || '',
      status: r.Status || r.status || '',
      created_at: r.Timestamp || r.timestamp || r.created_at || ''
    }));
    writeLeads(leads);
    // cleanup
    try{ fs.unlinkSync(req.file.path); } catch(_) {}
    return res.json({ ok:true, imported: leads.length });
  } catch (e) {
    console.error('CSV upload error', e && e.message ? e.message : e);
    return res.status(500).json({ ok:false, error:'csv_parse_failed', message: e && e.message ? e.message : String(e) });
  }
});

// POST /api/uploads/template
router.post('/template', upload.single('template'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok:false, error:'no_file' });
    const dest = path.join(__dirname, '..', 'templates');
    if (!fs.existsSync(dest)) fs.mkdirSync(dest);
    const out = path.join(dest, req.file.originalname);
    fs.renameSync(req.file.path, out);
    return res.json({ ok:true, saved: out });
  } catch (e) {
    console.error('template upload failed', e);
    return res.status(500).json({ ok:false, error:'save_failed', message: e && e.message ? e.message : String(e) });
  }
});

// POST /api/uploads/logo
router.post('/logo', upload.single('logo'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok:false, error:'no_file' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    const destDir = path.join(__dirname, '..', 'public', 'assets');
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, 'mc-logo' + (ext || '.png'));
    // move file
    fs.renameSync(req.file.path, dest);
    // optionally convert to png if ext != .png and imagemagick is installed (try convert)
    if (ext !== '.png') {
      try {
        const { execSync } = require('child_process');
        const pngDest = path.join(destDir, 'mc-logo.png');
        execSync(`convert "${dest}" "${pngDest}"`); // requires ImageMagick
        fs.unlinkSync(dest);
      } catch (e) {
        // conversion failed — keep uploaded file
      }
    }
    return res.json({ ok:true, saved: dest });
  } catch (e){
    console.error('logo upload failed', e);
    return res.status(500).json({ ok:false, error:'logo_failed', message: e && e.message ? e.message : String(e) });
  }
});

module.exports = router;
