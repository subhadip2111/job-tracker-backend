const express = require("express");
const nodemailer = require("nodemailer");
const cors = require("cors");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");

dotenv.config();

// ----------------------------
// CONNECT TO MONGODB
// ----------------------------
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch((err) => console.error("MongoDB Error:", err));

// ----------------------------
// MONGOOSE SCHEMA
// ----------------------------
const trackingSchema = new mongoose.Schema({
  trackingId: { type: String, required: true, unique: true },
  to: String,
  subject: String,
  body: String,
  role: String,
  company: String,
  status: { type: String, enum: ["SENT", "OPENED"], default: "SENT" },
  method: { type: String, enum: ["PIXEL", "CLICK", null], default: null },
  sentAt: { type: Date, default: Date.now },
  openedAt: { type: Date, default: null },
  ipAddress: String,
  userAgent: String,
  openCount: { type: Number, default: 0 },
});

const Tracking = mongoose.model("TrackingEmail", trackingSchema);

// ----------------------------
const app = express();
const PORT = process.env.PORT || 4000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.use(cors());
app.use(express.json());

// ----------------------------
// EMAIL CONFIG
// ----------------------------
const EMAIL_CONFIG = {
  host: process.env.NODE_MAILER_HOST || "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.NODE_MAILER_USER,
    pass: process.env.NODE_MAILER_PASSWORD,
  },
};

const transporter = nodemailer.createTransport(EMAIL_CONFIG);

// Verify email configuration
transporter.verify((error, success) => {
  if (error) {
    console.error("Email config error:", error);
  } else {
    console.log("Email server ready");
  }
});

// ----------------------------
// HELPER: Rewrite <a> tags for tracking
// ----------------------------
const rewriteLinksForTracking = (htmlBody, trackingId) => {
  const linkRegex = /<a\s+(?:[^>]*?\s+)?href="([^"]*)"([^>]*)>(.*?)<\/a>/gi;

  return htmlBody.replace(linkRegex, (match, url, attributes, content) => {
    if (url.startsWith("mailto:") || url.startsWith("#")) return match;

    const encodedUrl = encodeURIComponent(url);
    const trackingUrl = `${BASE_URL}/api/click?id=${trackingId}&url=${encodedUrl}`;
    return `<a href="${trackingUrl}"${attributes}>${content}</a>`;
  });
};

// ----------------------------
// SEND EMAIL
// ----------------------------
app.post("/api/send-email", async (req, res) => {
  const { to, subject, body, trackingId, role, company } = req.body;

  if (!to || !body || !trackingId) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    // Create database record
    await Tracking.create({
      trackingId,
      to,
      subject: subject || "Application",
      body,
      role: role || "Position",
      company: company || "Company",
      status: "SENT",
      method: null,
      sentAt: new Date(),
      openedAt: null,
      openCount: 0,
    });

    const pixelUrl = `${BASE_URL}/api/pixel/${trackingId}`;

    let processedBody = body.replace(/\n/g, "<br/>");
    processedBody = rewriteLinksForTracking(processedBody, trackingId);

    const htmlBody = `
      <div style="font-family: Helvetica, Arial, sans-serif; color: #333; line-height: 1.6;">
        ${processedBody}
        <br/><br/>
        <div style="margin-top: 30px; border-top: 1px solid #eaeaea; padding-top: 20px;">
          <p style="font-size: 12px; color: #999;">
            Application for <strong>${role || "Position"}</strong> at <strong>${company || "Company"}</strong>
          </p>
        </div>
        <img src="${pixelUrl}" width="1" height="1" alt="" style="display:block; opacity:0;" />
      </div>
    `;

    // Check if CV file exists
    const cvPath = path.join(__dirname, "subhadip.cv.pdf");
    const attachments = [];

    if (fs.existsSync(cvPath)) {
      attachments.push({
        filename: "subhadip.cv.pdf",
        path: cvPath,
      });
    } else {
      console.warn("CV file not found at:", cvPath);
    }

    const info = await transporter.sendMail({
      from: `"${process.env.SENDER_NAME || "Subhadip"}" <${EMAIL_CONFIG.auth.user}>`,
      to,
      subject: subject || "Application",
      html: htmlBody,
      attachments,
    });

    console.log(`[EMAIL SENT] To: ${to} | ID: ${trackingId}`);

    res.json({ success: true, messageId: info.messageId, trackingId });
  } catch (error) {
    console.error("EMAIL ERROR:", error);
    res.status(500).json({ 
      error: "Failed to send email", 
      details: error.message 
    });
  }
});

// ----------------------------
// CLICK TRACKING
// ----------------------------
app.get("/api/click", async (req, res) => {
  const { id, url } = req.query;

  if (!id || !url) {
    return res.status(400).send("Missing parameters");
  }

  try {
    const tracking = await Tracking.findOne({ trackingId: id });

    if (tracking) {
      console.log(`[TRACKING - CLICK] ID: ${id}`);

      const updateData = {
        openedAt: tracking.openedAt || new Date(),
        method: tracking.method || "CLICK",
        openCount: tracking.openCount + 1,
        ipAddress: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress,
        userAgent: req.headers['user-agent'],
      };

      // Only update status to OPENED if not already opened
      if (tracking.status !== "OPENED") {
        updateData.status = "OPENED";
      }

      await Tracking.updateOne({ trackingId: id }, updateData);
    }

    res.redirect(decodeURIComponent(url));
  } catch (error) {
    console.error("Click tracking error:", error);
    res.redirect(decodeURIComponent(url));
  }
});

// ----------------------------
// PIXEL TRACKING
// ----------------------------
app.get("/api/pixel/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const tracking = await Tracking.findOne({ trackingId: id });

    if (tracking) {
      console.log(`[TRACKING - PIXEL] ID: ${id}`);

      const updateData = {
        openCount: tracking.openCount + 1,
        ipAddress: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress,
        userAgent: req.headers['user-agent'],
      };

      // Only update status and openedAt if this is the first open
      if (tracking.status !== "OPENED") {
        updateData.status = "OPENED";
        updateData.openedAt = new Date();
        updateData.method = "PIXEL";
      }

      await Tracking.updateOne({ trackingId: id }, updateData);
    }
  } catch (error) {
    console.error("Pixel tracking error:", error);
  }

  // Return 1x1 transparent PNG
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64"
  );

  res.writeHead(200, {
    "Content-Type": "image/png",
    "Content-Length": png.length,
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
  });

  res.end(png);
});

// ----------------------------
// GET ALL LOGS
// ----------------------------
app.get("/api/tracking-status", async (req, res) => {
  try {
    const records = await Tracking.find().sort({ sentAt: -1 }).lean();
    return res.json(records);
  } catch (error) {
    console.error("Error fetching tracking status:", error);
    res.status(500).json({ error: "Failed to fetch tracking data" });
  }
});

// ----------------------------
// GET SINGLE TRACKING RECORD
// ----------------------------
app.get("/api/tracking/:id", async (req, res) => {
  try {
    const record = await Tracking.findOne({ trackingId: req.params.id });
    if (!record) {
      return res.status(404).json({ error: "Tracking record not found" });
    }
    res.json(record);
  } catch (error) {
    console.error("Error fetching tracking record:", error);
    res.status(500).json({ error: "Failed to fetch tracking record" });
  }
});

// ----------------------------
// HEALTH CHECK
// ----------------------------
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date() });
});

// ----------------------------
// START SERVER
// ----------------------------
app.listen(PORT, () => {
  console.log(`✅ Tracking server running → ${BASE_URL}`);
  console.log("📧 Mode: Pixel + Link Tracking + MongoDB");
  console.log("📊 Ready to track email opens and clicks");
});

module.exports = app;