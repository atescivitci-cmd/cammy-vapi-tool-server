// ============================================================
// Cammy Vapi Tool Server v1.1
// Handles 4 real-time tool calls from Vapi during voice calls:
//   POST /vapi/get_today_schedule
//   POST /vapi/get_urgent_emails
//   POST /vapi/get_open_loops
//   POST /vapi/get_brain_fact
//
// Auth strategy:
//   - Google Calendar / Gmail: GCAL_TOKEN env var (refreshed by Cammy cron)
//   - OneDrive reads: via search_files_v2 pattern through Pipedream
//     The server POSTs to the Perplexity tool proxy for file reads
//     (no direct Graph credentials needed)
// ============================================================

import express from "express";
import https from "https";
import http from "http";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ── Env vars ─────────────────────────────────────────────────
const GCAL_TOKEN        = process.env.GCAL_TOKEN;        // Google OAuth access token
const ONEDRIVE_ROUTER   = process.env.ONEDRIVE_ROUTER || "https://eoc09ly9stpskyz.m.pipedream.net";
const READ_ENDPOINT     = process.env.READ_ENDPOINT   || "https://eo54pqk9broiael.m.pipedream.net";
const BRAIN_ITEM_ID     = process.env.BRAIN_ITEM_ID   || "FD682E54F97FD13C!sfe87fab543a74c35a325354af330643e";

// ── Helper: HTTP/S GET with timeout ─────────────────────────
function get(url, headers = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { headers, timeout: timeoutMs }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
  });
}

// ── Helper: POST JSON ────────────────────────────────────────
function post(url, payload, headers = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const urlObj = new URL(url);
    const mod = url.startsWith("https") ? https : http;
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers },
      timeout: timeoutMs,
    };
    const req = mod.request(options, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Helper: ET formatting ─────────────────────────────────────
function todayISOET() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // YYYY-MM-DD
}

function nowET() {
  return new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
}

// ── Helper: read OneDrive file via read endpoint ──────────────
let brainCache = null;
let brainCacheAt = 0;

async function readBrain() {
  if (brainCache && Date.now() - brainCacheAt < 5 * 60 * 1000) return brainCache;
  // Try read endpoint with item_id
  const resp = await get(`${READ_ENDPOINT}?item_id=${encodeURIComponent(BRAIN_ITEM_ID)}`);
  if (resp.body?.download_url) {
    const dl = await get(resp.body.download_url);
    brainCache = typeof dl.body === "string" ? JSON.parse(dl.body) : dl.body;
    brainCacheAt = Date.now();
    return brainCache;
  }
  // Fallback: try router read action
  const resp2 = await post(ONEDRIVE_ROUTER, { action: "read", item_id: BRAIN_ITEM_ID });
  if (resp2.body?.download_url) {
    const dl2 = await get(resp2.body.download_url);
    brainCache = typeof dl2.body === "string" ? JSON.parse(dl2.body) : dl2.body;
    brainCacheAt = Date.now();
    return brainCache;
  }
  throw new Error("Could not read brain.json");
}

// ── Helper: extract Vapi tool call args ──────────────────────
function extractArgs(body) {
  if (body?.message?.toolCallList?.[0]) {
    const call = body.message.toolCallList[0];
    return { toolCallId: call.id, args: call.function?.arguments || {}, toolName: call.function?.name };
  }
  return { toolCallId: null, args: body || {}, toolName: null };
}

// ── Helper: Vapi-format response ─────────────────────────────
function vapiRespond(res, text, toolCallId) {
  if (toolCallId) {
    res.json({ results: [{ toolCallId, result: text }] });
  } else {
    res.json({ result: text });
  }
}

// ============================================================
// TOOL 1: get_today_schedule
// ============================================================
app.post("/vapi/get_today_schedule", async (req, res) => {
  const { toolCallId } = extractArgs(req.body);
  try {
    if (!GCAL_TOKEN) return vapiRespond(res, "Calendar access not configured.", toolCallId);

    const today = todayISOET();
    const startOfDay = `${today}T00:00:00-04:00`;
    const endOfDay   = `${today}T23:59:59-04:00`;
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(startOfDay)}&timeMax=${encodeURIComponent(endOfDay)}&singleEvents=true&orderBy=startTime&maxResults=20`;

    const resp = await get(url, { Authorization: `Bearer ${GCAL_TOKEN}` });
    const events = resp.body?.items || [];
    const now = new Date();

    const remaining = events.filter(e => {
      const start = new Date(e.start?.dateTime || e.start?.date);
      return start > new Date(now.getTime() - 15 * 60 * 1000);
    });

    if (!remaining.length) return vapiRespond(res, "Your calendar is clear for the rest of today.", toolCallId);

    const lines = remaining.map(e => {
      const start = new Date(e.start?.dateTime || e.start?.date);
      const t = start.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
      return `${t}: ${e.summary || "Untitled"}`;
    });

    vapiRespond(res, `You have ${remaining.length} item${remaining.length > 1 ? "s" : ""} remaining today. ${lines.join(". ")}.`, toolCallId);

  } catch (err) {
    console.error("[get_today_schedule]", err.message);
    vapiRespond(res, "I had trouble reaching your calendar. Try again in a moment.", toolCallId);
  }
});

// ============================================================
// TOOL 2: get_urgent_emails
// ============================================================
app.post("/vapi/get_urgent_emails", async (req, res) => {
  const { toolCallId } = extractArgs(req.body);
  try {
    if (!GCAL_TOKEN) return vapiRespond(res, "Email access not configured.", toolCallId);

    const T1 = ["beth", "izzy", "leo", "atil", "mehmet", "pat", "jack", "scott", "arun", "greg", "tugce", "efruz", "duncan"];
    const T3 = ["hannah", "marko iskander", "alex kokolis", "alex peters", "tanniss", "lex van", "johann eid"];
    const RECRUITER = ["opportunity", "role", "vp", "cro", "chief", "joining", "position", "executive"];
    const SKIP = ["osttra", "ion group", "trireduce", "traiana"];

    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().split("T")[0];
    const q = encodeURIComponent(`is:unread after:${yesterday}T00:00:00-04:00`);
    const listResp = await get(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=20`,
      { Authorization: `Bearer ${GCAL_TOKEN}` }
    );

    const messages = listResp.body?.messages || [];
    if (!messages.length) return vapiRespond(res, "No unread emails in the last 24 hours.", toolCallId);

    const hits = [];
    for (const msg of messages.slice(0, 15)) {
      const detail = await get(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
        { Authorization: `Bearer ${GCAL_TOKEN}` }
      );
      const hdrs = detail.body?.payload?.headers || [];
      const from = (hdrs.find(h => h.name === "From")?.value || "").toLowerCase();
      const subj = (hdrs.find(h => h.name === "Subject")?.value || "");
      const subjL = subj.toLowerCase();

      if (SKIP.some(k => from.includes(k) || subjL.includes(k))) continue;

      let tier = null;
      if (T1.some(n => from.includes(n))) tier = "T1";
      else if (T3.some(n => from.includes(n))) tier = "T3";
      else if (RECRUITER.some(k => subjL.includes(k))) tier = "RECRUITER";

      if (tier) {
        const name = from.split("<")[0].trim().split(" ")[0] || from.split("@")[0];
        hits.push({ name, subj, tier });
      }
    }

    if (!hits.length) return vapiRespond(res, "No high-priority emails right now.", toolCallId);

    const lines = hits.slice(0, 4).map(h => `From ${h.name}: ${h.subj}`).join(". ");
    vapiRespond(res, `You have ${hits.length} priority email${hits.length > 1 ? "s" : ""}. ${lines}.`, toolCallId);

  } catch (err) {
    console.error("[get_urgent_emails]", err.message);
    vapiRespond(res, "I had trouble reaching your inbox. Try again.", toolCallId);
  }
});

// ============================================================
// TOOL 3: get_open_loops
// ============================================================
app.post("/vapi/get_open_loops", async (req, res) => {
  const { toolCallId } = extractArgs(req.body);
  try {
    const brain = await readBrain();
    const loops = brain?.open_loops || brain?.openLoops || [];

    if (!loops.length) return vapiRespond(res, "No open items recorded. You are clear.", toolCallId);

    const items = loops.slice(0, 5).map(l =>
      typeof l === "string" ? l : (l.description || l.item || l.summary || JSON.stringify(l))
    );
    vapiRespond(res, `You have ${loops.length} open item${loops.length > 1 ? "s" : ""}. ${items.join(". ")}.`, toolCallId);

  } catch (err) {
    console.error("[get_open_loops]", err.message);
    vapiRespond(res, "I had trouble loading your open items. Try again.", toolCallId);
  }
});

// ============================================================
// TOOL 4: get_brain_fact
// ============================================================
app.post("/vapi/get_brain_fact", async (req, res) => {
  const { toolCallId, args } = extractArgs(req.body);
  const query = (args?.query || "").toLowerCase().trim();

  if (!query) return vapiRespond(res, "What would you like me to look up?", toolCallId);

  try {
    const brain = await readBrain();

    // Contact lookup
    const contacts = brain?.contacts || {};
    for (const [name, info] of Object.entries(contacts)) {
      const first = name.toLowerCase().split(" ")[0];
      if (query.includes(first) || first.includes(query.split(" ")[0])) {
        const phone = (info.phones || []).find(p => p && p !== "GAP") || null;
        const email = (info.emails || []).find(e => e && e !== "GAP") || null;
        const role = info.relationship || info.title || "";
        let ans = name;
        if (role) ans += `, ${role}`;
        if (phone) ans += `. Phone: ${phone}`;
        if (email) ans += `. Email: ${email}`;
        return vapiRespond(res, ans + ".", toolCallId);
      }
    }

    // Preferences
    const prefs = brain?.preferences || {};
    for (const [k, v] of Object.entries(prefs)) {
      if (query.includes(k.toLowerCase())) {
        return vapiRespond(res, `Your ${k} preference is: ${v}.`, toolCallId);
      }
    }

    vapiRespond(res, `Nothing found for "${args?.query}" in your knowledge base.`, toolCallId);

  } catch (err) {
    console.error("[get_brain_fact]", err.message);
    vapiRespond(res, "I had trouble accessing your knowledge base. Try again.", toolCallId);
  }
});

// ── Health check ─────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime(), time: nowET() }));
app.get("/", (_req, res) => res.json({ ok: true, server: "cammy-vapi-tool-server", v: "1.1" }));

app.listen(PORT, () => console.log(`[${nowET()}] Cammy Vapi Tool Server on port ${PORT}`));
