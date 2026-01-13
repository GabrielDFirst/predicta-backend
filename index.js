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
 * - DATABASE_URL           (Render Postgres External Database URL)
 *
 * Optional env vars:
 * - VERIFY_TOKEN           (only needed if you’re using Meta webhook verification)
 * - DEFAULT_WHATSAPP_TO    (fallback recipient if "to" is not provided)
 */

require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const { Pool } = require("pg"); // ✅ Step 2: Postgres

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// ==============================
// ✅ Step 2: Postgres connection (Render)
// ==============================
// Use Render Postgres "External Database URL" in DATABASE_URL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// Optional connectivity check (prints once at startup)
pool
  .query("SELECT 1")
  .then(() => console.log("Postgres connected ✅"))
  .catch((err) => console.error("Postgres connection error ❌", err));

// Twilio client (requires TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN)
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ==============================
// Predicta MVP: Event Engine (in-memory)
// ==============================

// Default currency per owner (you can expand this as you onboard people)
const OWNER_PROFILES = {
  "whatsapp:+447425524117": {
    businessName: "Gabriel Demo Business",
    defaultCurrency: "GBP",
  },
  // Add more owners like:
  // "whatsapp:+2348012345678": { businessName: "Mama T Foods", defaultCurrency: "NGN" },
};

// In-memory event store (will reset if Render restarts)
const EVENTS = [];

// Currency helpers
const SYMBOL_TO_CODE = { "£": "GBP", "$": "USD", "₦": "NGN" };
const CODE_SET = new Set(["GBP", "USD", "NGN"]);

function normalizeAmountToken(token) {
  // Removes commas (e.g., 45,000 -> 45000)
  return String(token).replace(/,/g, "").trim();
}

function parseAmountAndCurrency(rawAmountToken, maybeCurrencyToken, defaultCurrency) {
  const amtToken = normalizeAmountToken(rawAmountToken);

  // Case A: amount token includes a currency symbol e.g. "£45", "$120", "₦45000"
  const firstChar = amtToken.charAt(0);
  if (SYMBOL_TO_CODE[firstChar]) {
    const currency = SYMBOL_TO_CODE[firstChar];
    const amountStr = amtToken.slice(1);
    const amount = Number(amountStr);
    if (!Number.isFinite(amount)) return { error: "Invalid amount format." };
    return { amount, currency };
  }

  // Case B: currency is supplied as a separate token e.g. "45 GBP"
  const maybeCode = (maybeCurrencyToken || "").toUpperCase().trim();
  if (maybeCode && CODE_SET.has(maybeCode)) {
    const amount = Number(amtToken);
    if (!Number.isFinite(amount)) return { error: "Invalid amount format." };
    return { amount, currency: maybeCode };
  }

  // Case C: amount only -> default currency
  const amount = Number(amtToken);
  if (!Number.isFinite(amount)) return { error: "Invalid amount format." };
  return { amount, currency: defaultCurrency || "NGN" };
}

function getOwnerProfile(from) {
  return OWNER_PROFILES[from] || { businessName: "Your Business", defaultCurrency: "NGN" };
}

function helpText(businessName) {
  return (
    `Predicta (${businessName}) commands:\n` +
    `1) sale <item> <qty> <amount>[currency]\n` +
    `   e.g. sale rice 3 ₦45000 | sale rice 3 45 GBP | sale rice 3 £45\n` +
    `2) expense <category> <amount>[currency]\n` +
    `   e.g. expense fuel ₦15000 | expense ads $30 | expense rent 500 GBP\n` +
    `3) stock <item> <qty>\n` +
    `   e.g. stock rice 20\n` +
    `4) help`
  );
}

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
 */
app.get("/test-whatsapp", async (req, res) => {
  try {
    const message = await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: "whatsapp:+447425524117",
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
 */
app.post("/send-whatsapp", async (req, res) => {
  const apiKey = req.header("x-api-key");
  if (!process.env.PREDICTA_API_KEY || apiKey !== process.env.PREDICTA_API_KEY) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  try {
    const { to, body } = req.body || {};

    const finalTo = to || process.env.DEFAULT_WHATSAPP_TO;

    if (!finalTo || !body) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: to (or DEFAULT_WHATSAPP_TO), body",
      });
    }

    const toWhatsApp = finalTo.startsWith("whatsapp:")
      ? finalTo
      : `whatsapp:${finalTo}`;

    const message = await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
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

// ✅ INBOUND: TwiML auto-reply endpoint (Event Engine)
app.post("/twilio/whatsapp", (req, res) => {
  try {
    const from = req.body.From; // "whatsapp:+..."
    const incomingRaw = (req.body.Body || "").trim();

    const { businessName, defaultCurrency } = getOwnerProfile(from);

    console.log("Inbound WhatsApp (Event Engine):", { from, incomingRaw });

    const incoming = incomingRaw.replace(/\s+/g, " ");
    const parts = incoming.split(" ");
    const cmd = (parts[0] || "").toLowerCase();

    let reply = "";

    if (!from || !incoming) {
      reply = "Predicta: I received an empty message. Type 'help' for commands.";
    } else if (cmd === "help") {
      reply = helpText(businessName);
    } else if (cmd === "sale") {
      const item = parts[1];
      const qtyStr = parts[2];
      const amountToken = parts[3];
      const currencyToken = parts[4];

      const qty = Number(qtyStr);

      if (!item || !Number.isFinite(qty) || qty <= 0 || !amountToken) {
        reply = `Usage: sale <item> <qty> <amount>[currency]\nExample: sale rice 3 ₦45000`;
      } else {
        const parsed = parseAmountAndCurrency(amountToken, currencyToken, defaultCurrency);
        if (parsed.error) {
          reply = `Sale not recorded: ${parsed.error}`;
        } else {
          const event = {
            type: "sale",
            owner: from,
            businessName,
            item: item.toLowerCase(),
            quantity: qty,
            amount: parsed.amount,
            currency: parsed.currency,
            timestamp: new Date().toISOString(),
            raw: incomingRaw,
          };
          EVENTS.push(event);

          reply =
            `Sale recorded ✅\n` +
            `Item: ${event.item}\nQty: ${event.quantity}\nTotal: ${event.currency} ${event.amount}\n` +
            `Time: ${event.timestamp}`;
        }
      }
    } else if (cmd === "expense") {
      const category = parts[1];
      const amountToken = parts[2];
      const currencyToken = parts[3];

      if (!category || !amountToken) {
        reply = `Usage: expense <category> <amount>[currency]\nExample: expense fuel ₦15000`;
      } else {
        const parsed = parseAmountAndCurrency(amountToken, currencyToken, defaultCurrency);
        if (parsed.error) {
          reply = `Expense not recorded: ${parsed.error}`;
        } else {
          const event = {
            type: "expense",
            owner: from,
            businessName,
            category: category.toLowerCase(),
            amount: parsed.amount,
            currency: parsed.currency,
            timestamp: new Date().toISOString(),
            raw: incomingRaw,
          };
          EVENTS.push(event);

          reply =
            `Expense recorded ✅\n` +
            `Category: ${event.category}\nAmount: ${event.currency} ${event.amount}\n` +
            `Time: ${event.timestamp}`;
        }
      }
    } else if (cmd === "stock") {
      const item = parts[1];
      const qtyStr = parts[2];
      const qty = Number(qtyStr);

      if (!item || !Number.isFinite(qty) || qty < 0) {
        reply = `Usage: stock <item> <qty>\nExample: stock rice 20`;
      } else {
        const event = {
          type: "stock",
          owner: from,
          businessName,
          item: item.toLowerCase(),
          quantity: qty,
          timestamp: new Date().toISOString(),
          raw: incomingRaw,
        };
        EVENTS.push(event);

        reply =
          `Stock updated ✅\n` +
          `Item: ${event.item}\nQty: ${event.quantity}\n` +
          `Time: ${event.timestamp}`;
      }
    } else {
      reply =
        `I didn’t understand that.\n` +
        `Type "help" to see commands.\n\n` +
        `Example: sale rice 3 ₦45000`;
    }

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);
    return res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("Inbound Event Engine error:", err);
    return res.sendStatus(200);
  }
});

app.listen(PORT, () => {
  console.log(`Predicta running on port ${PORT}`);
  console.log(`VERIFY_TOKEN loaded: ${process.env.VERIFY_TOKEN ? "YES" : "NO"}`);
  console.log(`DATABASE_URL loaded: ${process.env.DATABASE_URL ? "YES" : "NO"}`);
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

