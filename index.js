require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const admin = require("firebase-admin");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "change-this-to-your-own-secret";
const UPLOAD_DIR = path.join(__dirname, "uploads");
const DB_FILE = path.join(__dirname, "detections.json");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "[]");

// ---- Firebase Admin, for sending push notifications only (free, no card) ----
let firebaseReady = false;
try {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    firebaseReady = true;
    console.log("Firebase Admin initialized — push notifications enabled.");
  } else {
    console.warn("FIREBASE_SERVICE_ACCOUNT_JSON not set — push notifications disabled.");
  }
} catch (err) {
  console.error("Failed to initialize Firebase Admin:", err.message);
}

async function sendPushNotification(detection) {
  if (!firebaseReady) return;
  try {
    const confidencePct = Math.round((detection.confidence || 0) * 100);
    await admin.messaging().send({
      topic: "detections",
      notification: {
        title: "Visitor Detected",
        body: confidencePct > 0
          ? `A person was detected (${confidencePct}% confidence).`
          : "A person was detected.",
      },
      data: {
        photoUrl: detection.photoUrl,
        confidence: String(detection.confidence || 0),
        detectionId: detection.id,
      },
      android: {
        priority: "high",
        notification: { channelId: "detections_channel" },
      },
    });
    console.log("Push sent for detection", detection.id);
  } catch (err) {
    console.error("Push notification failed:", err.message);
  }
}

// ---- Tiny JSON "database" ----
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

// ---- App ----
const app = express();
app.use(cors());
app.use(express.json());
app.use("/photos", express.static(UPLOAD_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const id = crypto.randomUUID();
      cb(null, `${id}.jpg`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

function requireApiKey(req, res, next) {
  const key = req.header("x-api-key") || req.query.key;
  if (key !== API_KEY) {
    return res.status(401).json({ error: "Invalid or missing API key" });
  }
  next();
}

function publicUrlFor(req) {
  return process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
}

app.get("/health", (req, res) => {
  res.json({ status: "ok", firebaseReady });
});

// ESP32 posts here: multipart/form-data with field "photo" (the JPEG)
// plus optional fields confidence, isManual, deviceId.
app.post("/detections", requireApiKey, upload.single("photo"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Missing 'photo' file field" });
  }

  const id = path.parse(req.file.filename).name;
  const detection = {
    id,
    photoUrl: `${publicUrlFor(req)}/photos/${req.file.filename}`,
    timestamp: new Date().toISOString(),
    confidence: parseFloat(req.body.confidence) || 0,
    isManual: req.body.isManual === "true" || req.body.isManual === "1",
    deviceId: req.body.deviceId || "esp32-cam",
  };

  const list = readDetections();
  list.unshift(detection); // newest first
  writeDetections(list.slice(0, 500)); // keep it from growing forever

  res.json({ status: "ok", detection });
  sendPushNotification(detection);
});

// App polls this for the history list / latest photo.
app.get("/detections", (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  res.json(readDetections().slice(0, limit));
});

app.delete("/detections/:id", requireApiKey, (req, res) => {
  const list = readDetections();
  const match = list.find((d) => d.id === req.params.id);
  const remaining = list.filter((d) => d.id !== req.params.id);
  writeDetections(remaining);

  if (match) {
    const filePath = path.join(UPLOAD_DIR, `${match.id}.jpg`);
    fs.unlink(filePath, () => {});
  }
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Visitor Detector server listening on port ${PORT}`);
});
