// Basic WhatsApp Webhook Server for Mr. Car

const express = require( "express" );
const bodyParser = require( "body-parser" ); 

const app = express();
app.use(bodyParser.json());

// ✅ Replace with your chosen verify token
const VERIFY_TOKEN = "MrCarVerify123";

// ✅ Webhook verification (Meta will call this)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified successfully");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});


// ✅ Message receiver
app.post("/webhook", (req, res) => {
  const body = req.body;
  console.log("Incoming message:", JSON.stringify(body, null, 2));

  // Always respond 200 to Meta to confirm receipt
  res.status(200).send("EVENT_RECEIVED");
});

// ✅ Run local server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log (` Mr. Car Webhook running on port ${PORT}`));





