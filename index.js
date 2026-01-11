/**
 * Predicta Backend (Express)
 * - Health check route: GET /
 * - Meta webhook verification: GET /webhook
 * - Incoming webhook receiver (Twilio-style logging + auto-reply): POST /webhook
 * - Twilio WhatsApp Sandbox test sender (TEMP): GET /test-whatsapp
 * - Outbound WhatsApp sender (protected): POST /send-whatsapp
 * - Optional TwiML inbound auto-reply endpoint: POST /twilio/whatsapp
 *
 * Required env vars:
 * - TWILIO_ACCOUNT_SID
 * - TWILIO_AUTH_TOKEN
 * - TWILIO_WHATSAPP_FROM   (e.g. whatsapp:+14155238886 for Twilio Sandbox)
 * - PREDICTA_API_KEY       (your own secret for protecting /send-whatsapp)
 *
 * Optional env vars:
 * - VERIFY_TOKEN           (only needed if you’re using Meta webhook verification)
 * - DEFAULT_WHATSAPP_TO    (fallback recipient if "to" is not provided)
 */

require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

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

// ✅ Incoming webhook messages (POST) + auto-reply (Twilio-style inbound payload)
app.post("/webhook", async (req, res) => {
  try {
    console.log("Incoming webhook payload:");
    console.log(JSON.stringify(req.body, null, 2));

    // Twilio inbound fields (WhatsApp Sandbox)
    const incomingMsg = req.body?.Body;
    const from = req.body?.From; // e.g. "whatsapp:+447...."

    // If this is not a Twilio message, just acknowledge
    if (!incomingMsg || !from) {
      return res.sendStatus(200);
    }

    console.log("Incoming message:", incomingMsg);
    console.log("From:", from);

    // Simple auto-reply (send back to the sender)
    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM, // e.g. whatsapp:+14155238886
      to: from,
      body: `👋 Hello! Predicta received: "${incomingMsg}"`,
    });

    return res.sendStatus(200);
  } catch (error) {
    console.error("Auto-reply error:", error);
    return res.sendStatus(500);
  }
});

/**
 * TEMPORARY: Test WhatsApp message via Twilio Sandbox
 *
 * IMPORTANT:
 * 1) TWILIO_WHATSAPP_FROM must be: whatsapp:+14155238886 (sandbox)
 * 2) You must have joined the Twilio sandbox from your phone already.
 * 3) "to" must be in format: whatsapp:+<E164 number>
 *
 * Tip: you can also read ?to=+447... from query if you want later.
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

    return res.status(500).json({
      success: false,
      message: error.message,
      code: error.code,
      moreInfo: error.moreInfo,
    });
  }
});

/**
 * OUTBOUND: Send WhatsApp message dynamically (protected with x-api-key)
 *
 * Request:
 * POST /send-whatsapp
 * Headers:
 * - Content-Type: application/json
 * - x-api-key: <your PREDICTA_API_KEY>
 * Body:
 * {
 *   "to": "+4474...." OR "whatsapp:+4474....",
 *   "body": "hello"
 * }
 *
 * Notes:
 * - If "to" is missing and DEFAULT_WHATSAPP_TO exists, it will use the default.
 * - "to" is normalized to whatsapp:+E164
 */
app.post("/send-whatsapp", async (req, res) => {
  // API key protection
  const apiKey = req.header("x-api-key");
  if (!process.env.PREDICTA_API_KEY || apiKey !== process.env.PREDICTA_API_KEY) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  try {
    const { to, body } = req.body || {};

    // Allow fallback to DEFAULT_WHATSAPP_TO if "to" not provided
    const finalTo = to || process.env.DEFAULT_WHATSAPP_TO;

    if (!finalTo || !body) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: to (or DEFAULT_WHATSAPP_TO), body",
      });
    }

    // Normalize to WhatsApp format
    const toWhatsApp = finalTo.startsWith("whatsapp:")
      ? finalTo
      : `whatsapp:${finalTo}`;

    const message = await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM, // whatsapp:+14155238886 (sandbox)
      to: toWhatsApp,
      body,
    });

    return res.json({
      success: true,
      sid: message.sid,
      status: message.status,
      to: message.to,
      from: message.from,
    });
  } catch (error) {
    console.error("Twilio send error:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
      code: error.code,
      moreInfo: error.moreInfo,
    });
  }
});

const PORT = process.env.PORT || 3000;

// ✅ INBOUND (Alternative): Twilio WhatsApp webhook (TwiML auto-reply)
app.post("/twilio/whatsapp", (req, res) => {
  try {
    const from = req.body.From; // e.g. "whatsapp:+447..."
    const incoming = req.body.Body; // message text

    console.log("Inbound WhatsApp (TwiML route):", { from, incoming });

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(`Hello 👋 I am Predicta. You said: "${incoming}"`);

    return res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("Inbound webhook error:", err);
    return res.sendStatus(200);
  }
});

app.listen(PORT, () => {
  console.log(`Predicta running on port ${PORT}`);
  console.log(`VERIFY_TOKEN loaded: ${process.env.VERIFY_TOKEN ? "YES" : "NO"}`);
  console.log(
    `TWILIO_ACCOUNT_SID loaded: ${process.env.TWILIO_ACCOUNT_SID ? "YES" : "NO"}`
  );
  console.log(
    `TWILIO_AUTH_TOKEN loaded: ${process.env.TWILIO_AUTH_TOKEN ? "YES" : "NO"}`
  );
  console.log(
    `TWILIO_WHATSAPP_FROM loaded: ${process.env.TWILIO_WHATSAPP_FROM ? "YES" : "NO"}`
  );
  console.log(
    `PREDICTA_API_KEY loaded: ${process.env.PREDICTA_API_KEY ? "YES" : "NO"}`
  );
});

