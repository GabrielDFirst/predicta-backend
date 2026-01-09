/**
 * Predicta Backend (Express)
 * - Health check route: GET /
 * - Meta webhook verification: GET /webhook
 * - Incoming webhook receiver: POST /webhook
 * - Twilio WhatsApp Sandbox test sender (TEMP): GET /test-whatsapp
 */

require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");

const app = express();
app.use(bodyParser.json());

// Twilio client (requires TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN)
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Health check
app.get("/", (req, res) => {
  res.status(200).send("Predicta backend running");
});

// Meta webhook verification (GET)
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Incoming webhook messages (POST)
app.post("/webhook", (req, res) => {
  console.log("Incoming webhook payload:");
  console.log(JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

/**
 * TEMPORARY: Test WhatsApp message via Twilio Sandbox
 *
 * IMPORTANT:
 * 1) Your environment variable must be:
 *    TWILIO_WHATSAPP_FROM = whatsapp:+14155238886
 * 2) You must have joined the Twilio sandbox from your phone already (Step 1).
 * 3) "to" must be in the format: whatsapp:+<E164 number>
 */
app.get("/test-whatsapp", async (req, res) => {
  try {
    const message = await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM, // e.g. whatsapp:+14155238886
      to: "whatsapp:+447425524117", // your personal WhatsApp number in E.164
      body: "✅ Predicta backend test via Twilio WhatsApp Sandbox",
    });

    return res.status(200).json({
      success: true,
      sid: message.sid,
      status: message.status,
      to: message.to,
      from: message.from,
    });
  } catch (error) {
    console.error("Twilio error:", error);

    // Twilio errors often include a "code" and more details
    return res.status(500).json({
      success: false,
      message: error.message,
      code: error.code,
      moreInfo: error.moreInfo,
    });
  }
});

const PORT = process.env.PORT || 3000;

// ✅ OUTBOUND: Send WhatsApp message dynamically
app.post("/send-whatsapp", async (req, res) => {
  try {
    const { to, body } = req.body;

    if (!to || !body) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: to, body",
      });
    }

    const toWhatsApp = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;

    const message = await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM, // whatsapp:+14155238886 (sandbox)
      to: toWhatsApp,
      body,
    });

    return res.json({
      success: true,
      sid: message.sid,
      status: message.status,
    });
  } catch (error) {
    console.error("Twilio send error:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});


app.listen(PORT, () => {
  console.log(`Predicta running on port ${PORT}`);
  console.log(`VERIFY_TOKEN loaded: ${process.env.VERIFY_TOKEN ? "YES" : "NO"}`);
  console.log(`TWILIO_ACCOUNT_SID loaded: ${process.env.TWILIO_ACCOUNT_SID ? "YES" : "NO"}`);
  console.log(`TWILIO_AUTH_TOKEN loaded: ${process.env.TWILIO_AUTH_TOKEN ? "YES" : "NO"}`);
  console.log(`TWILIO_WHATSAPP_FROM loaded: ${process.env.TWILIO_WHATSAPP_FROM ? "YES" : "NO"}`);
});
