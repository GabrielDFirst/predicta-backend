require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Predicta running on port ${PORT}`);
  console.log(`VERIFY_TOKEN loaded: ${process.env.VERIFY_TOKEN ? "YES" : "NO"}`);
});
