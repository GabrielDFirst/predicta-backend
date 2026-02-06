/**
 * Predicta Backend (Express)
 * - Health check route: GET /
 * - Meta webhook verification: GET /webhook
 * - Incoming webhook receiver (Twilio-style logging + auto-reply): POST /webhook
 * - Twilio WhatsApp Sandbox test sender (TEMP): GET /test-whatsapp
 * - Outbound WhatsApp sender (protected): POST /send-whatsapp
 * - Twilio WhatsApp inbound (TwiML): POST /twilio/whatsapp
 * - Admin DB init (protected): POST /admin/init-db
 * - Admin latest records (protected): GET /admin/latest
 * - Admin analytics summary (protected): GET /admin/summary?business_id=1&period=today|week|month
 *
 * Required env vars:
 * - TWILIO_ACCOUNT_SID
 * - TWILIO_AUTH_TOKEN
 * - TWILIO_WHATSAPP_FROM   (e.g. whatsapp:+14155238886 for Twilio Sandbox)
 * - PREDICTA_API_KEY       (your own secret for protecting /send-whatsapp + admin endpoints)
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
const { Pool } = require("pg");

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// ==============================
// Postgres connection (Render)
// ==============================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool
  .query("SELECT 1")
  .then(() => console.log("Postgres connected ✅"))
  .catch((err) => console.error("Postgres connection error ❌", err));

// Twilio client
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ==============================
// Predicta MVP: Event Engine
// ==============================
const OWNER_PROFILES = {
  "whatsapp:+447425524117": { businessName: "Gabriel Demo Business", defaultCurrency: "GBP" },
};

const EVENTS = []; // in-memory (debug only)

// Currency helpers
const SYMBOL_TO_CODE = { "£": "GBP", "$": "USD", "₦": "NGN" };
const CODE_SET = new Set(["GBP", "USD", "NGN"]);

function normalizeAmountToken(token) {
  return String(token || "").replace(/,/g, "").trim();
}

function parseAmountAndCurrency(rawAmountToken, maybeCurrencyToken, defaultCurrency) {
  const amtToken = normalizeAmountToken(rawAmountToken);
  if (!amtToken) return { error: "Invalid amount format." };

  const firstChar = amtToken.charAt(0);
  if (SYMBOL_TO_CODE[firstChar]) {
    const currency = SYMBOL_TO_CODE[firstChar];
    const amountStr = amtToken.slice(1);
    const amount = Number(amountStr);
    if (!Number.isFinite(amount)) return { error: "Invalid amount format." };
    return { amount, currency };
  }

  const maybeCode = normalizeAmountToken(maybeCurrencyToken).toUpperCase();
  if (maybeCode && CODE_SET.has(maybeCode)) {
    const amount = Number(amtToken);
    if (!Number.isFinite(amount)) return { error: "Invalid amount format." };
    return { amount, currency: maybeCode };
  }

  const amount = Number(amtToken);
  if (!Number.isFinite(amount)) return { error: "Invalid amount format." };
  return { amount, currency: defaultCurrency || "NGN" };
}

function getOwnerProfile(from) {
  return OWNER_PROFILES[from] || { businessName: "Your Business", defaultCurrency: "NGN" };
}

function helpText(businessName) {
  return (
    `🆕 PREDICTA BUILD: NL-PARSER-V1\n\n` +
    `Predicta (${businessName}) commands:\n` +
    `1) sale <item> <qty> <amount>[currency]\n` +
    `   e.g. sale rice 3 ₦45000 | sale rice 3 45 GBP | sale rice 3 £45\n` +
    `2) expense <category> <amount>[currency]\n` +
    `   e.g. expense fuel ₦15000 | expense ads $30 | expense rent 500 GBP\n` +
    `3) stock <item> <qty>\n` +
    `   e.g. stock rice 20\n` +
    `   also: add stock <item> <qty> | remove stock <item> <qty>\n` +
    `4) summary [today|week|month]\n` +
    `5) advice [today|week|month]\n` +
    `6) help\n\n` +
    `Natural language also works:\n` +
    `• Sold 3 bin for 400 gbp\n` +
    `• Spent £30 on fuel\n` +
    `• Add stock bin 10\n` +
    `• Remove stock bin 5`
  );
}

// ==============================
// DB Helpers
// ==============================
async function getOrCreateBusinessId(whatsappFrom, businessName, defaultCurrency) {
  const existing = await pool.query("SELECT id FROM businesses WHERE whatsapp_from = $1 LIMIT 1", [
    whatsappFrom,
  ]);
  if (existing.rows.length) return existing.rows[0].id;

  const created = await pool.query(
    `INSERT INTO businesses (business_name, whatsapp_from, default_currency)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [businessName, whatsappFrom, defaultCurrency || "NGN"]
  );
  return created.rows[0].id;
}

async function insertSale(businessId, item, quantity, amount, currency) {
  await pool.query(
    `INSERT INTO sales (business_id, item, quantity, amount, currency)
     VALUES ($1, $2, $3, $4, $5)`,
    [businessId, item, quantity, amount, currency]
  );
}

async function insertExpense(businessId, category, amount, currency) {
  await pool.query(
    `INSERT INTO expenses (business_id, category, amount, currency)
     VALUES ($1, $2, $3, $4)`,
    [businessId, category, amount, currency]
  );
}

async function insertStockEvent(businessId, item, quantity) {
  await pool.query(
    `INSERT INTO stock_events (business_id, item, quantity)
     VALUES ($1, $2, $3)`,
    [businessId, item, quantity]
  );
}

async function getLatestStockQty(businessId, item) {
  const r = await pool.query(
    `
    SELECT quantity
    FROM stock_events
    WHERE business_id = $1 AND item = $2
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [businessId, item]
  );
  if (!r.rows.length) return 0;
  const q = Number(r.rows[0].quantity);
  return Number.isFinite(q) ? q : 0;
}

// ==============================
// Step 6B: Smart Insights + Advice (rule-based)
// ==============================
function safeNum(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}

function computeInsightsFromSummary(summary) {
  const tips = [];

  const salesArr = summary?.totals?.sales_by_currency || [];
  const expArr = summary?.totals?.expenses_by_currency || [];
  const topProducts = summary?.insights?.top_products_by_revenue || [];
  const stockSnap = summary?.insights?.stock_snapshot || [];

  const totalSalesAll = salesArr.reduce((acc, s) => acc + safeNum(s.total_amount), 0);
  if (totalSalesAll <= 0) {
    tips.push("📉 No sales recorded in this period. Try logging at least 3 sales to unlock better insights.");
  }

  const totalExpAll = expArr.reduce((acc, e) => acc + safeNum(e.total_amount), 0);
  if (totalExpAll <= 0) {
    tips.push("🧾 No expenses recorded. Track costs (fuel, rent, ads) so profit is accurate.");
  }

  if (topProducts.length >= 2) {
    const top1 = safeNum(topProducts[0].revenue);
    const sumTop = topProducts.reduce((acc, p) => acc + safeNum(p.revenue), 0);
    if (sumTop > 0 && top1 / sumTop >= 0.7) {
      tips.push(`⚠️ Most revenue comes from "${topProducts[0].item}". Consider pushing 1–2 other products to reduce risk.`);
    }
  } else if (topProducts.length === 1) {
    tips.push(`📌 Top product is "${topProducts[0].item}". Add more product sales for richer insights.`);
  }

  if (stockSnap.length > 0) {
    const s0 = stockSnap[0];
    const qty = safeNum(s0.quantity);
    if (qty === 0) tips.push(`🚨 Stockout risk: "${s0.item}" stock is 0. Restock soon.`);
    if (qty >= 200) tips.push(`📦 High stock: "${s0.item}" is ${qty}. Consider a promo to increase turnover.`);
  } else {
    tips.push('📦 No stock updates found. Use: stock <item> <qty> (e.g. "stock rice 20").');
  }

  const netBy = summary?.totals?.net_by_currency || {};
  for (const [cur, net] of Object.entries(netBy)) {
    if (safeNum(net) < 0) tips.push(`🔻 Net is negative in ${cur}. Review expenses and pricing.`);
  }

  return tips.slice(0, 6);
}

function formatAdviceMessage(summary) {
  const businessName = summary?.business?.business_name || "Your Business";
  const period = summary?.period || "period";
  const tips = computeInsightsFromSummary(summary);

  const topProducts = summary?.insights?.top_products_by_revenue || [];
  const topLine =
    topProducts.length > 0
      ? `🏆 Top product: ${topProducts[0].item} (${topProducts[0].currency} ${safeNum(topProducts[0].revenue)})`
      : "🏆 Top product: None yet";

  return [
    `🧠 Predicta Advice (${businessName})`,
    `Period: ${period}`,
    "",
    topLine,
    "",
    "✅ Actionable tips:",
    ...tips.map((t) => `• ${t}`),
    "",
    `Tip: try "summary week"`,
  ].join("\n");
}

function appendInsightsToSummaryText(summaryText, summaryObj) {
  const tips = computeInsightsFromSummary(summaryObj);
  if (!tips.length) return summaryText;
  return `${summaryText}\n\n🧠 Insights:\n${tips.map((t) => `• ${t}`).join("\n")}`;
}

function adaptInternalSummaryToAdminShape(internalSummary, period) {
  return {
    period: String(period || "today").toLowerCase(),
    business: internalSummary.business,
    totals: {
      sales_by_currency: (internalSummary.totals.salesTotals || []).map((r) => ({
        currency: r.currency,
        total_amount: Number(r.total_amount),
        total_qty: Number(r.total_qty),
      })),
      expenses_by_currency: (internalSummary.totals.expenseTotals || []).map((r) => ({
        currency: r.currency,
        total_amount: Number(r.total_amount),
      })),
      net_by_currency: internalSummary.totals.netByCurrency || {},
    },
    insights: {
      top_products_by_revenue: (internalSummary.insights.topProductsByRevenue || []).map((r) => ({
        item: r.item,
        currency: r.currency,
        revenue: Number(r.revenue),
        qty: Number(r.qty),
      })),
      top_expense_categories: (internalSummary.insights.topExpenseCategories || []).map((r) => ({
        category: r.category,
        currency: r.currency,
        total: Number(r.total),
      })),
      stock_snapshot: (internalSummary.insights.stockSnapshot || []).map((r) => ({
        item: r.item,
        quantity: Number(r.quantity),
        last_updated: r.created_at,
      })),
    },
  };
}

// ==============================
// Step 6A: Summary engine + WhatsApp formatting
// ==============================
function periodToInterval(period) {
  const p = String(period || "today").toLowerCase();
  if (p === "week" || p === "7d") return "7 days";
  if (p === "month" || p === "30d") return "30 days";
  return "1 day";
}

function formatMoney(currency, amount) {
  const n = Number(amount || 0);
  return `${currency} ${Number.isFinite(n) ? n : 0}`;
}

async function getBusinessSummary(businessId, period) {
  const intervalSql = periodToInterval(period);
  const sinceSql = `NOW() - INTERVAL '${intervalSql}'`;

  const businessInfo = await pool.query(
    `SELECT id, business_name, whatsapp_from, default_currency
     FROM businesses
     WHERE id = $1
     LIMIT 1`,
    [businessId]
  );

  const salesTotals = await pool.query(
    `
    SELECT currency, COALESCE(SUM(amount),0) AS total_amount, COALESCE(SUM(quantity),0) AS total_qty
    FROM sales
    WHERE business_id = $1 AND created_at >= ${sinceSql}
    GROUP BY currency
    ORDER BY total_amount DESC
    `,
    [businessId]
  );

  const expenseTotals = await pool.query(
    `
    SELECT currency, COALESCE(SUM(amount),0) AS total_amount
    FROM expenses
    WHERE business_id = $1 AND created_at >= ${sinceSql}
    GROUP BY currency
    ORDER BY total_amount DESC
    `,
    [businessId]
  );

  const topProductsByRevenue = await pool.query(
    `
    SELECT item, currency, COALESCE(SUM(amount),0) AS revenue, COALESCE(SUM(quantity),0) AS qty
    FROM sales
    WHERE business_id = $1 AND created_at >= ${sinceSql}
    GROUP BY item, currency
    ORDER BY revenue DESC
    LIMIT 3
    `,
    [businessId]
  );

  const topExpenseCategories = await pool.query(
    `
    SELECT category, currency, COALESCE(SUM(amount),0) AS total
    FROM expenses
    WHERE business_id = $1 AND created_at >= ${sinceSql}
    GROUP BY category, currency
    ORDER BY total DESC
    LIMIT 3
    `,
    [businessId]
  );

  const stockSnapshot = await pool.query(
    `
    SELECT DISTINCT ON (item)
      item, quantity, created_at
    FROM stock_events
    WHERE business_id = $1
    ORDER BY item, created_at DESC
    `,
    [businessId]
  );

  const salesMap = {};
  for (const r of salesTotals.rows) salesMap[r.currency] = Number(r.total_amount);

  const expMap = {};
  for (const r of expenseTotals.rows) expMap[r.currency] = Number(r.total_amount);

  const currencies = new Set([...Object.keys(salesMap), ...Object.keys(expMap)]);
  const netByCurrency = {};
  for (const c of currencies) netByCurrency[c] = (salesMap[c] || 0) - (expMap[c] || 0);

  return {
    intervalSql,
    business: businessInfo.rows[0] || null,
    totals: { salesTotals: salesTotals.rows, expenseTotals: expenseTotals.rows, netByCurrency },
    insights: {
      topProductsByRevenue: topProductsByRevenue.rows,
      topExpenseCategories: topExpenseCategories.rows,
      stockSnapshot: stockSnapshot.rows,
    },
  };
}

function buildWhatsAppSummaryText(summary, period) {
  const businessName = summary.business?.business_name || "Your Business";
  const p = String(period || "today").toLowerCase();

  const salesLines =
    summary.totals.salesTotals.length > 0
      ? summary.totals.salesTotals
          .map((r) => `• ${formatMoney(r.currency, r.total_amount)} (qty: ${Number(r.total_qty)})`)
          .join("\n")
      : "• None";

  const expenseLines =
    summary.totals.expenseTotals.length > 0
      ? summary.totals.expenseTotals.map((r) => `• ${formatMoney(r.currency, r.total_amount)}`).join("\n")
      : "• None";

  const netLines =
    Object.keys(summary.totals.netByCurrency).length > 0
      ? Object.entries(summary.totals.netByCurrency).map(([c, v]) => `• ${formatMoney(c, v)}`).join("\n")
      : "• 0";

  const topSales =
    summary.insights.topProductsByRevenue.length > 0
      ? summary.insights.topProductsByRevenue
          .map((r) => `• ${r.item}: ${formatMoney(r.currency, r.revenue)} (qty: ${Number(r.qty)})`)
          .join("\n")
      : "• None";

  const topExpenses =
    summary.insights.topExpenseCategories.length > 0
      ? summary.insights.topExpenseCategories
          .map((r) => `• ${r.category}: ${formatMoney(r.currency, r.total)}`)
          .join("\n")
      : "• None";

  const stockPreview =
    summary.insights.stockSnapshot.length > 0
      ? summary.insights.stockSnapshot.slice(0, 5).map((r) => `• ${r.item}: ${Number(r.quantity)}`).join("\n")
      : "• None";

  return (
    `📊 Predicta Summary (${businessName})\n` +
    `Period: ${p} (last ${summary.intervalSql})\n\n` +
    `💰 Sales:\n${salesLines}\n\n` +
    `💸 Expenses:\n${expenseLines}\n\n` +
    `📈 Net:\n${netLines}\n\n` +
    `🏆 Top sales:\n${topSales}\n\n` +
    `🧾 Top expenses:\n${topExpenses}\n\n` +
    `📦 Stock (latest):\n${stockPreview}\n\n` +
    `Tip: send "summary week" or "advice week"`
  );
}

// ==============================
// Middleware: API key guard (for admin + outbound)
// ==============================
function requireApiKey(req, res, next) {
  const apiKey = req.header("x-api-key");
  if (!process.env.PREDICTA_API_KEY || apiKey !== process.env.PREDICTA_API_KEY) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  return next();
}

// ==============================
// Natural language parser (A/B/C)
// ==============================
function normalizeIncomingNL(raw) {
  const s = String(raw || "").trim().replace(/\s+/g, " ");
  const lower = s.toLowerCase();

  // Summary/advice
  if (lower.startsWith("summary")) return s;
  if (lower.startsWith("advice")) return s;
  if (lower === "help") return "help";

  // Sold 3 bin for 400 gbp
  // Sold 3 bin for £400
  {
    const m = s.match(/^sold\s+(\d+)\s+(.+?)\s+for\s+(.+)$/i);
    if (m) {
      const qty = m[1];
      const item = m[2].trim().replace(/\s+/g, "_"); // keep 1 token
      const rest = m[3].trim();
      const parts = rest.split(" ");
      // rest may be "£400" or "400 gbp"
      const amountToken = parts[0];
      const currencyToken = parts[1];
      return `sale ${item} ${qty} ${amountToken}${currencyToken ? " " + currencyToken : ""}`;
    }
  }

  // Spent £30 on fuel
  // Spent 30 gbp on fuel
  // Spent $30 ads
  {
    const m = s.match(/^spent\s+(.+?)\s+on\s+(.+)$/i);
    if (m) {
      const amountPart = m[1].trim();
      const category = m[2].trim().replace(/\s+/g, "_");
      const parts = amountPart.split(" ");
      const amountToken = parts[0];
      const currencyToken = parts[1];
      return `expense ${category} ${amountToken}${currencyToken ? " " + currencyToken : ""}`;
    }
  }

  // Add stock bin 10
  {
    const m = s.match(/^add\s+stock\s+(.+?)\s+(\d+)$/i);
    if (m) {
      const item = m[1].trim().replace(/\s+/g, "_");
      const qty = m[2];
      return `stockadd ${item} ${qty}`;
    }
  }

  // Remove stock bin 5
  {
    const m = s.match(/^remove\s+stock\s+(.+?)\s+(\d+)$/i);
    if (m) {
      const item = m[1].trim().replace(/\s+/g, "_");
      const qty = m[2];
      return `stockremove ${item} ${qty}`;
    }
  }

  // If user types: "stock bin 400" / "sale bin 3 £400" etc, keep it.
  return s;
}

function unTokenizeItem(token) {
  return String(token || "").replace(/_/g, " ").trim();
}

// ==============================
// Routes
// ==============================

// Health
app.get("/", (req, res) => res.status(200).send("Predicta backend running"));

// Meta verification (optional)
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// Basic inbound (optional legacy route)
app.post("/webhook", async (req, res) => {
  try {
    console.log("Incoming webhook payload:");
    console.log(JSON.stringify(req.body, null, 2));

    const incomingMsg = req.body?.Body;
    const from = req.body?.From;

    if (!incomingMsg || !from) return res.sendStatus(200);

    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: from,
      body: `👋 Hello! Predicta received: "${incomingMsg}"`,
    });

    return res.sendStatus(200);
  } catch (error) {
    console.error("Auto-reply error:", error);
    return res.sendStatus(500);
  }
});

// Test sender
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
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Outbound protected
app.post("/send-whatsapp", requireApiKey, async (req, res) => {
  try {
    const { to, body } = req.body || {};
    const finalTo = to || process.env.DEFAULT_WHATSAPP_TO;

    if (!finalTo || !body) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: to (or DEFAULT_WHATSAPP_TO), body",
      });
    }

    const toWhatsApp = finalTo.startsWith("whatsapp:") ? finalTo : `whatsapp:${finalTo}`;

    const message = await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: toWhatsApp,
      body,
    });

    return res.json({ success: true, sid: message.sid, status: message.status });
  } catch (error) {
    console.error("Twilio send error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Inbound: Twilio WhatsApp webhook (TwiML)
// IMPORTANT: Always return TwiML, even on errors
app.post("/twilio/whatsapp", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const from = req.body.From; // "whatsapp:+..."
    const incomingRaw = (req.body.Body || "").trim();

    if (!from || !incomingRaw) {
      twiml.message("Predicta: I received an empty message. Type 'help' for commands.");
      return res.type("text/xml").status(200).send(twiml.toString());
    }

    const { businessName, defaultCurrency } = getOwnerProfile(from);
    const businessId = await getOrCreateBusinessId(from, businessName, defaultCurrency);

    console.log("Inbound WhatsApp:", { from, incomingRaw, businessId });

    // Natural language normalization
    const normalized = normalizeIncomingNL(incomingRaw);
    const incoming = normalized.replace(/\s+/g, " ");
    const parts = incoming.split(" ");
    const cmd = (parts[0] || "").toLowerCase();

    let reply = "";

    if (cmd === "help") {
      reply = helpText(businessName);

    } else if (cmd === "summary") {
      const period = (parts[1] || "today").toLowerCase();
      const internalSummary = await getBusinessSummary(businessId, period);
      const summaryText = buildWhatsAppSummaryText(internalSummary, period);
      const adminShapeSummary = adaptInternalSummaryToAdminShape(internalSummary, period);
      reply = appendInsightsToSummaryText(summaryText, adminShapeSummary);

    } else if (cmd === "advice") {
      const period = (parts[1] || "today").toLowerCase();
      const internalSummary = await getBusinessSummary(businessId, period);
      const adminShapeSummary = adaptInternalSummaryToAdminShape(internalSummary, period);
      reply = formatAdviceMessage(adminShapeSummary);

    } else if (cmd === "sale") {
      const itemToken = parts[1];
      const qtyStr = parts[2];
      const amountToken = parts[3];
      const currencyToken = parts[4];
      const qty = Number(qtyStr);
      const item = unTokenizeItem(itemToken).toLowerCase();

      if (!itemToken || !Number.isFinite(qty) || qty <= 0 || !amountToken) {
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
            businessId,
            item,
            quantity: qty,
            amount: parsed.amount,
            currency: parsed.currency,
            timestamp: new Date().toISOString(),
            raw: incomingRaw,
          };
          EVENTS.push(event);
          await insertSale(businessId, event.item, event.quantity, event.amount, event.currency);

          reply =
            `✅ Sale recorded\n` +
            `Item: ${event.item}\n` +
            `Qty: ${event.quantity}\n` +
            `Total: ${event.currency} ${event.amount}\n` +
            `Time: ${event.timestamp}`;
        }
      }

    } else if (cmd === "expense") {
      const categoryToken = parts[1];
      const amountToken = parts[2];
      const currencyToken = parts[3];
      const category = unTokenizeItem(categoryToken).toLowerCase();

      if (!categoryToken || !amountToken) {
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
            businessId,
            category,
            amount: parsed.amount,
            currency: parsed.currency,
            timestamp: new Date().toISOString(),
            raw: incomingRaw,
          };
          EVENTS.push(event);
          await insertExpense(businessId, event.category, event.amount, event.currency);

          reply =
            `✅ Expense recorded\n` +
            `Category: ${event.category}\n` +
            `Amount: ${event.currency} ${event.amount}\n` +
            `Time: ${event.timestamp}`;
        }
      }

    } else if (cmd === "stock") {
      // stock <item> <qty>  (SET)
      const itemToken = parts[1];
      const qtyStr = parts[2];
      const qty = Number(qtyStr);
      const item = unTokenizeItem(itemToken).toLowerCase();

      if (!itemToken || !Number.isFinite(qty) || qty < 0) {
        reply = `Usage: stock <item> <qty>\nExample: stock rice 20`;
      } else {
        await insertStockEvent(businessId, item, qty);
        reply =
          `✅ Stock updated (set)\n` +
          `Item: ${item}\n` +
          `Qty: ${qty}\n` +
          `Time: ${new Date().toISOString()}`;
      }

    } else if (cmd === "stockadd") {
      // add stock <item> <qty>  (INCREMENT)
      const itemToken = parts[1];
      const qtyStr = parts[2];
      const delta = Number(qtyStr);
      const item = unTokenizeItem(itemToken).toLowerCase();

      if (!itemToken || !Number.isFinite(delta) || delta <= 0) {
        reply = `Usage: add stock <item> <qty>\nExample: add stock rice 10`;
      } else {
        const current = await getLatestStockQty(businessId, item);
        const next = current + delta;
        await insertStockEvent(businessId, item, next);

        reply =
          `✅ Stock updated (added)\n` +
          `Item: ${item}\n` +
          `Added: ${delta}\n` +
          `New stock: ${next}\n` +
          `Time: ${new Date().toISOString()}`;
      }

    } else if (cmd === "stockremove") {
      // remove stock <item> <qty>  (DECREMENT)
      const itemToken = parts[1];
      const qtyStr = parts[2];
      const delta = Number(qtyStr);
      const item = unTokenizeItem(itemToken).toLowerCase();

      if (!itemToken || !Number.isFinite(delta) || delta <= 0) {
        reply = `Usage: remove stock <item> <qty>\nExample: remove stock rice 5`;
      } else {
        const current = await getLatestStockQty(businessId, item);
        const next = Math.max(0, current - delta);
        await insertStockEvent(businessId, item, next);

        reply =
          `✅ Stock updated (removed)\n` +
          `Item: ${item}\n` +
          `Removed: ${delta}\n` +
          `New stock: ${next}\n` +
          `Time: ${new Date().toISOString()}`;
      }

    } else {
      reply =
        `I didn’t understand that.\n` +
        `Type "help" to see commands.\n\n` +
        `Examples:\n` +
        `• Sold 3 bin for 400 gbp\n` +
        `• Spent £30 on fuel\n` +
        `• Add stock bin 10\n` +
        `• Summary week`;
    }

    console.log("Reply ->", reply); // 🔥 critical debug

    twiml.message(reply);
    return res.type("text/xml").status(200).send(twiml.toString());
  } catch (err) {
    console.error("Inbound Event Engine error:", err);

    // ✅ Always respond with TwiML so Twilio can send something
    twiml.message("⚠️ Predicta had a temporary error. Please try again in 30 seconds.");
    return res.type("text/xml").status(200).send(twiml.toString());
  }
});

// Admin: init DB (protected)
app.post("/admin/init-db", requireApiKey, async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS businesses (
        id SERIAL PRIMARY KEY,
        business_name TEXT NOT NULL,
        whatsapp_from TEXT UNIQUE NOT NULL,
        default_currency TEXT DEFAULT 'NGN',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sales (
        id SERIAL PRIMARY KEY,
        business_id INT REFERENCES businesses(id) ON DELETE CASCADE,
        item TEXT NOT NULL,
        quantity INT NOT NULL,
        amount NUMERIC NOT NULL,
        currency TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id SERIAL PRIMARY KEY,
        business_id INT REFERENCES businesses(id) ON DELETE CASCADE,
        category TEXT NOT NULL,
        amount NUMERIC NOT NULL,
        currency TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS stock_events (
        id SERIAL PRIMARY KEY,
        business_id INT REFERENCES businesses(id) ON DELETE CASCADE,
        item TEXT NOT NULL,
        quantity INT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    return res.json({ success: true, message: "DB tables created/verified ✅" });
  } catch (err) {
    console.error("init-db error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Admin: latest (protected)
app.get("/admin/latest", requireApiKey, async (req, res) => {
  try {
    const businesses = await pool.query(
      "SELECT id, business_name, whatsapp_from, default_currency, created_at FROM businesses ORDER BY id DESC LIMIT 5"
    );

    const sales = await pool.query(
      `SELECT s.id, s.business_id, s.item, s.quantity, s.amount, s.currency, s.created_at
       FROM sales s
       ORDER BY s.id DESC
       LIMIT 10`
    );

    const expenses = await pool.query(
      `SELECT e.id, e.business_id, e.category, e.amount, e.currency, e.created_at
       FROM expenses e
       ORDER BY e.id DESC
       LIMIT 10`
    );

    const stock = await pool.query(
      `SELECT se.id, se.business_id, se.item, se.quantity, se.created_at
       FROM stock_events se
       ORDER BY se.id DESC
       LIMIT 10`
    );

    return res.json({
      success: true,
      businesses: businesses.rows,
      sales: sales.rows,
      expenses: expenses.rows,
      stock_events: stock.rows,
    });
  } catch (err) {
    console.error("admin/latest error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Admin: analytics summary (protected)
app.get("/admin/summary", requireApiKey, async (req, res) => {
  try {
    const period = String(req.query.period || "today").toLowerCase();
    const businessId = Number(req.query.business_id || 0);

    if (!businessId || !Number.isFinite(businessId)) {
      return res.status(400).json({
        success: false,
        error: "Missing/invalid business_id. Example: /admin/summary?business_id=1&period=today",
      });
    }

    let intervalSql = "1 day";
    if (period === "week" || period === "7d") intervalSql = "7 days";
    if (period === "month" || period === "30d") intervalSql = "30 days";

    const sinceSql = `NOW() - INTERVAL '${intervalSql}'`;

    const salesTotals = await pool.query(
      `
      SELECT currency, COALESCE(SUM(amount),0) AS total_amount, COALESCE(SUM(quantity),0) AS total_qty
      FROM sales
      WHERE business_id = $1 AND created_at >= ${sinceSql}
      GROUP BY currency
      ORDER BY total_amount DESC
      `,
      [businessId]
    );

    const expenseTotals = await pool.query(
      `
      SELECT currency, COALESCE(SUM(amount),0) AS total_amount
      FROM expenses
      WHERE business_id = $1 AND created_at >= ${sinceSql}
      GROUP BY currency
      ORDER BY total_amount DESC
      `,
      [businessId]
    );

    const salesMap = {};
    for (const r of salesTotals.rows) salesMap[r.currency] = Number(r.total_amount);

    const expMap = {};
    for (const r of expenseTotals.rows) expMap[r.currency] = Number(r.total_amount);

    const currencies = new Set([...Object.keys(salesMap), ...Object.keys(expMap)]);
    const netByCurrency = {};
    for (const c of currencies) netByCurrency[c] = (salesMap[c] || 0) - (expMap[c] || 0);

    const topProductsByRevenue = await pool.query(
      `
      SELECT item, currency, COALESCE(SUM(amount),0) AS revenue, COALESCE(SUM(quantity),0) AS qty
      FROM sales
      WHERE business_id = $1 AND created_at >= ${sinceSql}
      GROUP BY item, currency
      ORDER BY revenue DESC
      LIMIT 5
      `,
      [businessId]
    );

    const topProductsByQty = await pool.query(
      `
      SELECT item, COALESCE(SUM(quantity),0) AS qty
      FROM sales
      WHERE business_id = $1 AND created_at >= ${sinceSql}
      GROUP BY item
      ORDER BY qty DESC
      LIMIT 5
      `,
      [businessId]
    );

    const topExpenseCategories = await pool.query(
      `
      SELECT category, currency, COALESCE(SUM(amount),0) AS total
      FROM expenses
      WHERE business_id = $1 AND created_at >= ${sinceSql}
      GROUP BY category, currency
      ORDER BY total DESC
      LIMIT 5
      `,
      [businessId]
    );

    const stockSnapshot = await pool.query(
      `
      SELECT DISTINCT ON (item)
        item, quantity, created_at
      FROM stock_events
      WHERE business_id = $1
      ORDER BY item, created_at DESC
      `,
      [businessId]
    );

    const businessInfo = await pool.query(
      `SELECT id, business_name, whatsapp_from, default_currency, created_at
       FROM businesses
       WHERE id = $1
       LIMIT 1`,
      [businessId]
    );

    return res.json({
      success: true,
      period,
      window: { since: `now - ${intervalSql}` },
      business: businessInfo.rows[0] || null,
      totals: {
        sales_by_currency: salesTotals.rows.map((r) => ({
          currency: r.currency,
          total_amount: Number(r.total_amount),
          total_qty: Number(r.total_qty),
        })),
        expenses_by_currency: expenseTotals.rows.map((r) => ({
          currency: r.currency,
          total_amount: Number(r.total_amount),
        })),
        net_by_currency: netByCurrency,
      },
      insights: {
        top_products_by_revenue: topProductsByRevenue.rows.map((r) => ({
          item: r.item,
          currency: r.currency,
          revenue: Number(r.revenue),
          qty: Number(r.qty),
        })),
        top_products_by_qty: topProductsByQty.rows.map((r) => ({
          item: r.item,
          qty: Number(r.qty),
        })),
        top_expense_categories: topExpenseCategories.rows.map((r) => ({
          category: r.category,
          currency: r.currency,
          total: Number(r.total),
        })),
        stock_snapshot: stockSnapshot.rows.map((r) => ({
          item: r.item,
          quantity: Number(r.quantity),
          last_updated: r.created_at,
        })),
      },
    });
  } catch (err) {
    console.error("admin/summary error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Predicta running on port ${PORT}`);
  console.log(`VERIFY_TOKEN loaded: ${process.env.VERIFY_TOKEN ? "YES" : "NO"}`);
  console.log(`DATABASE_URL loaded: ${process.env.DATABASE_URL ? "YES" : "NO"}`);
  console.log(`TWILIO_ACCOUNT_SID loaded: ${process.env.TWILIO_ACCOUNT_SID ? "YES" : "NO"}`);
  console.log(`TWILIO_AUTH_TOKEN loaded: ${process.env.TWILIO_AUTH_TOKEN ? "YES" : "NO"}`);
  console.log(`TWILIO_WHATSAPP_FROM loaded: ${process.env.TWILIO_WHATSAPP_FROM ? "YES" : "NO"}`);
  console.log(`PREDICTA_API_KEY loaded: ${process.env.PREDICTA_API_KEY ? "YES" : "NO"}`);
});

