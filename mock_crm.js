const express = require('express');
const app = express();
app.use(express.json());

// Simple local CRM simulator for testing webhook integration
app.post('/prompt', (req, res) => {
  const { from, message } = req.body || {};
  console.log('📩 Received from webhook:', { from, message });

  res.json({
    reply: `Signature Savings: Received "${message}" from ${from}.`,
    type: 'text',
    metadata: {
      model: 'TOYOTA HYCROSS ZX',
      price: 3450000,
      tone: 'luxury'
    }
  });
});

app.listen(4000, () => console.log('✅ Mock CRM listening on port 4000'));
