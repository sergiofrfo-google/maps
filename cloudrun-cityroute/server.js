/* MapVivid — CityRoute Async Worker
 * Cloud Run service:
 *  - POST /v1/jobs           (creates Firestore job + enqueues Cloud Task)
 *  - POST /v1/tasks/runJob   (Cloud Tasks target; does OpenAI work + writes result)
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const admin = require("firebase-admin");
const { CloudTasksClient } = require("@google-cloud/tasks");

admin.initializeApp(); // Cloud Run service account (ADC)
const db = admin.firestore();
const tasks = new CloudTasksClient();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

/** =========================
 *  ENV CONFIG (set in Cloud Run)
 *  ========================= */
const PROJECT_ID = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
const TASKS_LOCATION = process.env.TASKS_LOCATION || "us-central1";
const TASKS_QUEUE = process.env.TASKS_QUEUE || "cityroute-jobs";
const TASKS_WORKER_URL = process.env.TASKS_WORKER_URL || ""; // e.g. https://SERVICE-xxxxx.a.run.app/v1/tasks/runJob
const TASKS_TOKEN = process.env.TASKS_TOKEN || ""; // shared secret header

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";

if (!PROJECT_ID) console.warn("Missing PROJECT_ID env (GOOGLE_CLOUD_PROJECT).");
if (!TASKS_WORKER_URL) console.warn("Missing TASKS_WORKER_URL env.");
if (!TASKS_TOKEN) console.warn("Missing TASKS_TOKEN env.");
if (!OPENAI_API_KEY) console.warn("Missing OPENAI_API_KEY env.");

/** =========================
 *  Auth helper (Firebase ID token)
 *  ========================= */
async function requireFirebaseUser(req) {
  const authz = (req.headers.authorization || "").toString();
  const m = authz.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new Error("Missing Authorization: Bearer <FirebaseIDToken>");
  const token = m[1];
  const decoded = await admin.auth().verifyIdToken(token);
  return decoded; // { uid, ... }
}

/** =========================
 *  Payload normalization (match your GAS logic)
 *  ========================= */
function clampStayDays(payload) {
  const out = { ...payload };

  const noDates = out.no_dates === "1" || out.no_dates === true;
  const stay = Number(out.stay_days || 0);

  if (noDates) {
    if (stay) out.stay_days = Math.max(1, Math.min(7, Math.floor(stay)));
    return out;
  }

  if (out.start_date && out.end_date) {
    const s = new Date(out.start_date);
    const e = new Date(out.end_date);
    const ms = e - s;
    const d = Math.floor(ms / 86400000) + 1;
    out.stay_days = Math.max(1, Math.min(7, d));
  } else if (stay) {
    out.stay_days = Math.max(1, Math.min(7, Math.floor(stay)));
  }

  return out;
}

function stopsPerDayExact(pace) {
  const n = Number(pace || 3);
  if (n <= 1) return "~1-2";
  if (n === 2) return "~2-3";
  if (n === 3) return "~3-4";
  if (n === 4) return "~4-5";
  return "~5-7";
}

function buildPromptPlan(data) {
  const stops = stopsPerDayExact(data.pace);
  const dateLine = (data.no_dates === "1" || data.no_dates === true)
    ? `Plan for ${data.stay_days} day(s).`
    : `Trip dates: ${data.start_date || ""} to ${data.end_date || ""} (inclusive)`;

  return `
You are a travel route planner. Produce an ordered, neighborhood-clustered plan, and concise per-day tips.

Input:
- City: ${data.city}
- Country: ${data.country}
- ${dateLine}
- Traveling with: ${(data.companion_type || "unspecified").replace(/_/g, " ")}
- Interests: ${(data.categories || []).join(", ") || "none"}
- Mobility: ${(data.mobility || []).join(", ") || "unspecified"}
- Pace (1–5): ${data.pace || ""}
- Budget per day: ${(data.budget && data.budget.value) ? data.budget.value : "n/a"} ${(data.budget && data.budget.currency) ? data.budget.currency : ""}
- Extra requests: ${data.extra_requests || "none"}

Rules:
- Distribute activities across ${data.stay_days || 1} day(s) with realistic timing & compact routing.
- "name" MUST be ONLY the exact POI/place name as typed in Google Maps (no instructions; no multiple places).
- Provide lat & lng. If uncertain, choose a reasonable approximate point for the named place.
- For EACH day, produce ${stops} stops.
- Per-day tips must reflect the day's route and places (routing, best windows, crowd patterns, money/time savers).
- Keep descriptions short (≤ 20 words); keep tips concise (2–3 sentences total per day).

Output ONLY valid JSON:

{
  "itinerary": [
    {
      "name": "POI name only",
      "description": "very short",
      "day": number,
      "time": "HH:MM",
      "lat": number,
      "lng": number
    }
  ],
  "day_tips": {
    "1": "2–3 sentences with practical advice for day 1",
    "2": "…"
  }
}
`.trim();
}

function buildPromptCityTips(data) {
  const selected = Array.isArray(data.tip_focus) ? data.tip_focus.filter(Boolean) : [];
  if (!selected.length) {
    return `Output ONLY valid JSON: { "city_tips": {} }`;
  }

  return `
You are a travel advisor. Provide city-level tips only for ${data.city}, ${data.country}.

Rules (STRICT):
- Include tips ONLY for these categories: ${selected.join(", ")}.
- The JSON MUST contain exactly these keys and no others.
- Tips must be specific and actionable (place names, stations/lines, areas, time/money details).

Output ONLY valid JSON with exactly these keys:
{
  "city_tips": {
    ${selected.map(k => `"${k}": ["tip 1", "tip 2"]`).join(",\n    ")}
  }
}
`.trim();
}

/** =========================
 *  OpenAI call (Responses API)
 *  ========================= */
function cleanJSON(content) {
  return String(content || "")
    .replace(/^\s*```(?:json|javascript)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim()
    .replace(/\u00A0/g, " ")
    .replace(/,\s*([}\]])/g, "$1");
}

function parseJSONWithRepair(raw) {
  try {
    return JSON.parse(raw);
  } catch (e1) {
    const fixed = raw
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/([\}\]])\s*,\s*([\}\]])/g, "$1$2");
    return JSON.parse(fixed);
  }
}

async function callOpenAI(prompt) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: prompt,
      // store: false, // keep off; we store results in Firestore
      text: { format: { type: "json_object" } }
    })
  });

  const body = await res.text();
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${body.slice(0, 800)}`);

  const data = JSON.parse(body);
  const responseId = data.id || "";

  const textOut = (typeof data.output_text === "string" && data.output_text.trim())
    ? data.output_text.trim()
    : "";

  if (!textOut) throw new Error("Empty OpenAI output_text");

  const cleaned = cleanJSON(textOut);
  const parsed = parseJSONWithRepair(cleaned);
  return { parsed, responseId };
}

/** =========================
 *  Create Cloud Task
 *  ========================= */
async function enqueueJob(jobId) {
  if (!TASKS_WORKER_URL) throw new Error("Missing TASKS_WORKER_URL env");
  if (!TASKS_TOKEN) throw new Error("Missing TASKS_TOKEN env");

  const parent = tasks.queuePath(PROJECT_ID, TASKS_LOCATION, TASKS_QUEUE);

  const task = {
    httpRequest: {
      httpMethod: "POST",
      url: TASKS_WORKER_URL,
      headers: {
        "Content-Type": "application/json",
        "X-Tasks-Token": TASKS_TOKEN
      },
      body: Buffer.from(JSON.stringify({ jobId })).toString("base64")
    }
  };

  const [resp] = await tasks.createTask({ parent, task });
  return resp.name;
}

/** =========================
 *  ROUTES
 *  ========================= */

// Create job (client calls this)
app.post("/v1/jobs", async (req, res) => {
  try {
    const user = await requireFirebaseUser(req);

    const inputRaw = req.body || {};
    const input = clampStayDays({
      city: String(inputRaw.city || "").trim(),
      country: String(inputRaw.country || "").trim(),
      start_date: String(inputRaw.start_date || "").trim(),
      end_date: String(inputRaw.end_date || "").trim(),
      no_dates: inputRaw.no_dates ? "1" : "",
      stay_days: String(inputRaw.stay_days || "").trim(),

      categories: Array.isArray(inputRaw.categories) ? inputRaw.categories : [],
      mobility: Array.isArray(inputRaw.mobility) ? inputRaw.mobility : [],
      companion_type: String(inputRaw.companion_type || "").trim(),
      tip_focus: Array.isArray(inputRaw.tip_focus) ? inputRaw.tip_focus : [],

      pace: String(inputRaw.pace || "").trim(),
      budget: inputRaw.budget && typeof inputRaw.budget === "object" ? inputRaw.budget : { value: "", currency: "" },
      extra_requests: String(inputRaw.extra_requests || "").trim(),
      email: String(inputRaw.email || "").trim()
    });

    if (!input.city || !input.country) {
      return res.status(400).json({ error: "Missing city/country" });
    }

    const jobId = crypto.randomUUID();
    const now = admin.firestore.FieldValue.serverTimestamp();

    await db.collection("jobs").doc(jobId).set({
      ownerUid: user.uid,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      input
    });

    // enqueue async worker
    await enqueueJob(jobId);

    res.json({ jobId });
  } catch (err) {
    res.status(401).json({ error: String(err.message || err) });
  }
});

// Cloud Tasks worker (ONLY tasks should call this)
app.post("/v1/tasks/runJob", async (req, res) => {
  try {
    const token = String(req.headers["x-tasks-token"] || "");
    if (!TASKS_TOKEN || token !== TASKS_TOKEN) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const jobId = String(req.body?.jobId || "").trim();
    if (!jobId) return res.status(400).json({ error: "Missing jobId" });

    const ref = db.collection("jobs").doc(jobId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "Job not found" });

    const job = snap.data();
    const input = job.input || {};

    await ref.update({
      status: "running",
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Generate plan + city tips (same idea as your current dual-request)
    const [plan, tips] = await Promise.all([
      callOpenAI(buildPromptPlan(input)),
      callOpenAI(buildPromptCityTips(input))
    ]);

    const itinerary = Array.isArray(plan.parsed?.itinerary) ? plan.parsed.itinerary : [];
    const day_tips = (plan.parsed?.day_tips && typeof plan.parsed.day_tips === "object") ? plan.parsed.day_tips : {};
    const city_tips = (tips.parsed?.city_tips && typeof tips.parsed.city_tips === "object") ? tips.parsed.city_tips : {};

    await ref.update({
      status: "done",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      result: { itinerary, day_tips, city_tips },
      debug: {
        plan_response_id: plan.responseId || "",
        tips_response_id: tips.responseId || ""
      }
    });

    // Notification:
    // - simplest: email (optional) — implement with Brevo/SendGrid later
    // - for now, the front-end shows a shareable status link

    res.json({ ok: true });
  } catch (err) {
    const jobId = String(req.body?.jobId || "").trim();
    if (jobId) {
      try {
        await db.collection("jobs").doc(jobId).update({
          status: "error",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          error: String(err.message || err).slice(0, 1500)
        });
      } catch {}
    }
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/healthz", (_, res) => res.json({ ok: true }));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Listening on", port));
