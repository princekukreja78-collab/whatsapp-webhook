const express = require('express');
const router = express.Router();

// Placeholder CRM routes file so require('./routes/crm.cjs') does not break.
// We keep this minimal to avoid impacting existing flows in server.cjs.

router.get('/health', (req, res) => {
  res.json({ ok: true, source: 'routes/crm.cjs placeholder' });
});

module.exports = router;
