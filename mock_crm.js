const express = require('express');
const app = express();
app.use(express.json());
app.post('/leads', (req,res) => {
  console.log('MOCK /leads', JSON.stringify(req.body).slice(0,800));
  return res.json({ ok:true, id: 'MOCK_LEAD_' + Date.now() });
});
app.post('/prompt', (req,res) => {
  console.log('MOCK /prompt', JSON.stringify(req.body).slice(0,800));
  // return text & optional buttons to simulate CRM behaviour
  return res.json({ text: "Mock CRM reply: we have a great deal. Reply *BOOK* to proceed.", buttons: ["Book","More info"] });
});
const port = 4000;
app.listen(port, ()=> console.log("Mock CRM listening on", port));
