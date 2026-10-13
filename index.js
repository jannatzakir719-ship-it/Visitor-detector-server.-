require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "change-this-to-your-own-secret";
const DB_FILE = path.join(__dirname, "detections.json");

// Ensure JSON database file exists
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "[]");

// ---- JSON Database Helpers ----
function readDetections() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return [];
  }
}

function writeDetections(list) {
  fs.writeFileSync(DB_FILE, JSON.stringify(list, null, 2));
}

// ---- Express Setup ----
const app = express();
app.use(cors());
app.use(express.json()); // Parses incoming JSON payloads

// API Key protection middleware
function requireApiKey(req, res, next) {
  const key = req.header("x-api-key") || req.query.key;
  if (key !== API_KEY) {
    return res.status(401).json({ error: "Invalid or missing API key" });
  }
  next();
}

// ---- API Routes ----

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// POST API: Receives JSON data (confidence, message, timestamp) from ESP32
app.post("/detections", (req, res) => {
  const { confidence, message, deviceId } = req.body;

  const detection = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(), // Server recorded timestamp
    confidence: parseFloat(confidence) || 0,
    message: message || "Person detected",
    deviceId: deviceId || "esp32-cam",
  };

  // Save to local JSON database
  const list = readDetections();
  list.unshift(detection); // Newest first
  writeDetections(list.slice(0, 500)); // Keep max 500 records

  console.log(`[Detection Saved] ID: ${detection.id} | Message: ${detection.message} | Confidence: ${detection.confidence}% | Time: ${detection.timestamp}`);
  res.json({ status: "ok", detection });
});

// GET API: Fetch the list of saved detections
app.get("/detections", (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  res.json(readDetections().slice(0, limit));
});

// DELETE API: Remove a detection record by ID
app.delete("/detections/:id", requireApiKey, (req, res) => {
  const list = readDetections();
  const remaining = list.filter((d) => d.id !== req.params.id);
  writeDetections(remaining);
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Visitor Detector server listening on port ${PORT}`);
});
