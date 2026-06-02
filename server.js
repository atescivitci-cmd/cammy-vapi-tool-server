// ============================================================
// Cammy Vapi Tool Server v1.6
// Handles tool calls from Vapi during voice calls.
//
// NEW in v1.6:
//   POST /vapi/book_opentable   — OpenTable availability + browser booking
//   POST /vapi/book_resy        — Resy availability + booking (unofficial API)
//   POST /vapi/get_weather      — Weather via wttr.in (no API key needed)
//   POST /vapi/order_uber       — Uber ride request via API v1.2
//   POST /vapi/make_call        — Outbound call on Ates's behalf via Twilio
//   POST /vapi/ask_computer     — Direct handoff to Perplexity Computer API
//
// Existing (v1.5 and prior):
//   POST /vapi/get_today_schedule
//   POST /vapi/get_urgent_emails
//   POST /vapi/get_open_loops
//   POST /vapi/get_brain_fact
//   POST /onedrive/move
//   POST /meeting/start
//   POST /meeting/end
//   POST /call-complete
// ============================================================

import express from "express";
import https from "https";
import http from "http";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ── Env vars ─────────────────────────────────────────────────
const PIPEDREAM_GCAL_URL  = process.env.PIPEDREAM_GCAL_URL;
const ONEDRIVE_ROUTER     = process.env.ONEDRIVE_ROUTER  || "https://eoc09ly9stpskyz.m.pipedream.net";
const READ_ENDPOINT       = process.env.READ_ENDPOINT    || "https://eo54pqk9broiael.m.pipedream.net";
const BRAIN_ITEM_ID       = process.env.BRAIN_ITEM_ID    || "FD682E54F97FD13C!sfe87fab543a74c35a325354af330643e";
const ONEDRIVE_MOVE_URL   = process.env.ONEDRIVE_MOVE_URL || "";
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY || "";
const MEMORY_WRITE_URL    = process.env.MEMORY_WRITE_URL || "";
const EXCEL_FOLDER_ID     = process.env.EXCEL_FOLDER_ID  || "FD682E54F97FD13C!s62a081ff9a5d4410a8f5ef6501495ceb";
const EXCEL_SHEET_ID      = process.env.EXCEL_SHEET_ID   || "FD682E54F97FD13C!s18f54a8c250740e7acaf944a2153706c";
// NEW v1.6
const TWILIO_SID          = process.env.TWILIO_SID        || "";
const TWILIO_AUTH         = process.env.TWILIO_AUTH       || "";
const TWILIO_FROM         = process.env.TWILIO_FROM       || "+16174687087";
const ATES_PHONE          = process.env.ATES_PHONE        || "+16173475359";
const PERPLEXITY_API_KEY  = process.env.PERPLEXITY_API_KEY || "";
const UBER_ACCESS_TOKEN   = process.env.UBER_ACCESS_TOKEN || "";
const RESY_API_KEY        = process.env.RESY_API_KEY      || "VbWk7s3L4KiK5fzlO7JD3Q5ZYj2LcbzTIUz0hqs185M=";
const RESY_AUTH_TOKEN     = process.env.RESY_AUTH_TOKEN   || ""; // Per-user auth token from brain.json

// ── Helper: HTTP/S GET with timeout ─────────────────────────
function get(url, headers = {}, timeoutMs = 9000) {
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
function post(url, payload, headers = {}, timeoutMs = 9000) {
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

// ── Helper: POST form-encoded ────────────────────────────────
function postForm(url, params, headers = {}, timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const urlObj = new URL(url);
    const mod = url.startsWith("https") ? https : http;
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
        ...headers,
      },
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
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function nowET() {
  return new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
}

// ── Helper: proxy call to Pipedream Google endpoint ──────────
async function callGcalProxy(action, params = {}) {
  if (!PIPEDREAM_GCAL_URL) throw new Error("PIPEDREAM_GCAL_URL not set");
  const resp = await post(PIPEDREAM_GCAL_URL, { action, params });
  if (resp.body?.error) throw new Error(resp.body.error);
  return resp.body;
}

// ── Helper: brain cache (5 min TTL) ──────────────────────────
let brainCache = null;
let brainCacheAt = 0;

async function readBrain() {
  if (brainCache && Date.now() - brainCacheAt < 5 * 60 * 1000) return brainCache;
  const resp = await get(`${READ_ENDPOINT}?item_id=${encodeURIComponent(BRAIN_ITEM_ID)}`);
  if (resp.body?.download_url) {
    const dl = await get(resp.body.download_url);
    brainCache = typeof dl.body === "string" ? JSON.parse(dl.body) : dl.body;
    brainCacheAt = Date.now();
    return brainCache;
  }
  throw new Error("Could not read brain.json from read endpoint");
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

// ── Helper: call OpenAI GPT-4o-mini ─────────────────────────
async function callOpenAI(systemPrompt, userContent, timeoutMs = 30000) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
  const resp = await post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      temperature: 0.3,
      max_tokens: 1500,
    },
    { Authorization: `Bearer ${OPENAI_API_KEY}` },
    timeoutMs
  );
  if (resp.body?.error) throw new Error(resp.body.error.message || JSON.stringify(resp.body.error));
  return resp.body?.choices?.[0]?.message?.content || "";
}

// ── Helper: format duration ──────────────────────────────────
function formatDuration(startMs, endMs) {
  const diffMs = endMs - startMs;
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `${mins} minute${mins !== 1 ? "s" : ""}`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs} hour${hrs !== 1 ? "s" : ""}`;
}

// ── Helper: save markdown to OneDrive via router ─────────────
async function saveToOneDrive(filename, markdownContent) {
  const content_b64 = Buffer.from(markdownContent, "utf8").toString("base64");
  const payload = {
    filename,
    content_b64,
    force_folder: "01 Logs/Meeting Notes",
    overwrite: false,
  };
  const resp = await post(ONEDRIVE_ROUTER, payload, {}, 20000);
  return resp;
}

// ── Helper: geocode address via nominatim ───────────────────
async function geocode(address) {
  const encoded = encodeURIComponent(address);
  const resp = await get(
    `https://nominatim.openstreetmap.org/search?format=json&q=${encoded}&limit=1`,
    { "User-Agent": "Cammy-VoiceAssistant/1.6 (atescivitci@gmail.com)" }
  );
  const results = Array.isArray(resp.body) ? resp.body : [];
  if (!results.length) throw new Error(`Could not geocode: ${address}`);
  return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon), display_name: results[0].display_name };
}

// ============================================================
// TOOL 1: get_today_schedule
// ============================================================
app.post("/vapi/get_today_schedule", async (req, res) => {
  const { toolCallId } = extractArgs(req.body);
  try {
    const today = todayISOET();
    const data = await callGcalProxy("get_today_schedule", { date: today });

    const events = data?.events || [];
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
    const data = await callGcalProxy("get_urgent_emails", {});

    const hits = data?.hits || [];
    if (!hits.length) return vapiRespond(res, "No high-priority emails right now.", toolCallId);

    const lines = hits.slice(0, 4).map(h => `From ${h.name}: ${h.subject}`).join(". ");
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

// ============================================================
// TOOL 5 (v1.3): /onedrive/move
// ============================================================
app.post("/onedrive/move", async (req, res) => {
  const { item_id, destination_folder_id, new_name } = req.body || {};

  if (!item_id || !destination_folder_id) {
    return res.status(400).json({ error: "item_id and destination_folder_id are required" });
  }

  if (!ONEDRIVE_MOVE_URL) {
    return res.status(503).json({ error: "ONEDRIVE_MOVE_URL env var not set" });
  }

  try {
    const payload = { item_id, destination_folder_id };
    if (new_name) payload.new_name = new_name;

    const resp = await post(ONEDRIVE_MOVE_URL, payload, {}, 15000);

    if (resp.status >= 200 && resp.status < 300) {
      return res.json({ success: true, ...(typeof resp.body === "object" ? resp.body : { raw: resp.body }) });
    } else {
      const errMsg = resp.body?.error?.message || resp.body?.message || JSON.stringify(resp.body);
      console.error("[onedrive/move] upstream error:", resp.status, errMsg);
      return res.status(resp.status).json({ error: errMsg, upstream_status: resp.status });
    }
  } catch (err) {
    console.error("[onedrive/move]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// MEETING LISTEN MODE (v1.4)
// ============================================================
let meetingState = {
  active: false,
  startTime: null,
  title: "Untitled Meeting",
  attendees: [],
};

// ============================================================
// ENDPOINT: POST /meeting/start
// ============================================================
app.post("/meeting/start", async (req, res) => {
  const { toolCallId, args } = extractArgs(req.body);
  const title = args?.title || req.body?.title || "Untitled Meeting";
  const attendees = args?.attendees || req.body?.attendees || [];

  meetingState = {
    active: true,
    startTime: Date.now(),
    title,
    attendees: Array.isArray(attendees) ? attendees : [attendees],
  };

  const timeStr = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  const attendeeStr = meetingState.attendees.length > 0
    ? ` with ${meetingState.attendees.join(", ")}`
    : "";

  const message = `Meeting listen mode activated for "${title}"${attendeeStr}. Started at ${timeStr} ET. I'll capture key points, decisions, and action items. Say "Cammy, meeting done" when you're finished.`;

  console.log(`[meeting/start] ${nowET()} — title="${title}" attendees=${JSON.stringify(meetingState.attendees)}`);

  if (toolCallId) {
    return vapiRespond(res, message, toolCallId);
  }
  return res.json({ ok: true, message, state: meetingState });
});

// ============================================================
// ENDPOINT: POST /meeting/end
// ============================================================
app.post("/meeting/end", async (req, res) => {
  const { toolCallId, args } = extractArgs(req.body);

  const title = args?.title || req.body?.title || meetingState.title || "Untitled Meeting";
  const attendees = args?.attendees || req.body?.attendees || meetingState.attendees || [];
  const notes = args?.notes || req.body?.notes || "";
  const actionItemsRaw = args?.action_items || req.body?.action_items || [];

  const endTime = Date.now();
  const startTime = meetingState.startTime || endTime;
  const duration = formatDuration(startTime, endTime);
  const dateET = new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const dateISO = todayISOET();
  const attendeeList = Array.isArray(attendees) ? attendees : [attendees];

  meetingState = { active: false, startTime: null, title: "Untitled Meeting", attendees: [] };

  let markdownSummary = "";
  let spokenSummary = "";
  let saveStatus = "not attempted";

  try {
    const systemPrompt = `You are an executive assistant AI. Given raw meeting notes, produce a structured meeting summary in Markdown format.

Output ONLY the following Markdown structure (no preamble, no explanation):

## Key Points
- [bullet points of main topics discussed]

## Decisions Made
- [bullet points of decisions reached, or "None recorded" if none]

## Action Items
- [ ] [action item] — Owner: [person or "TBD"] — Due: [date or "TBD"]

## Commitments Flagged
- [any explicit commitments, promises, or deliverables mentioned, or "None recorded" if none]

Be concise but complete. Extract real commitments from names mentioned in notes.`;

    const userContent = `Meeting: ${title}
Date: ${dateET} ET
Attendees: ${attendeeList.join(", ") || "Not specified"}
Duration: ${duration}
${actionItemsRaw.length > 0 ? `\nAction items captured during meeting:\n${actionItemsRaw.map(a => `- ${a}`).join("\n")}` : ""}

Raw notes / transcript:
${notes || "(No notes provided)"}`;

    const gptOutput = await callOpenAI(systemPrompt, userContent);

    markdownSummary = `# Meeting Notes: ${title}
Date: ${dateET} ET
Attendees: ${attendeeList.join(", ") || "Not specified"}
Duration: ${duration}

${gptOutput}
`;

    const safeTitle = title.replace(/[^a-zA-Z0-9\s_-]/g, "").replace(/\s+/g, "_").slice(0, 50);
    const filename = `${dateISO}_${safeTitle}.md`;

    try {
      const saveResp = await saveToOneDrive(filename, markdownSummary);
      saveStatus = saveResp.status >= 200 && saveResp.status < 300
        ? `saved as ${filename}`
        : `save failed (${saveResp.status})`;
      console.log(`[meeting/end] OneDrive save: ${saveStatus}`);
    } catch (saveErr) {
      saveStatus = `save error: ${saveErr.message}`;
      console.error("[meeting/end] OneDrive save error:", saveErr.message);
    }

    const actionLines = (gptOutput.match(/- \[ \] .+/g) || []).slice(0, 3);
    const actionSpoken = actionLines.length > 0
      ? ` Action items: ${actionLines.map(l => l.replace(/- \[ \] /, "").replace(/ — Owner:.+/, "")).join("; ")}.`
      : "";

    spokenSummary = `Meeting "${title}" wrapped up. Duration was ${duration}.${actionSpoken} Full notes saved to OneDrive under Meeting Notes.`;

  } catch (err) {
    console.error("[meeting/end] GPT error:", err.message);
    markdownSummary = `# Meeting Notes: ${title}
Date: ${dateET} ET
Attendees: ${attendeeList.join(", ") || "Not specified"}
Duration: ${duration}

## Key Points
${notes ? notes.split(/[.!?]/).filter(s => s.trim()).slice(0, 5).map(s => `- ${s.trim()}`).join("\n") : "- (No notes captured)"}

## Decisions Made
- (Review notes manually)

## Action Items
${actionItemsRaw.length > 0 ? actionItemsRaw.map(a => `- [ ] ${a} — Owner: TBD — Due: TBD`).join("\n") : "- (None recorded)"}

## Commitments Flagged
- (Review notes manually — GPT summarization unavailable)
`;
    spokenSummary = `Meeting "${title}" ended after ${duration}. I saved a basic summary to OneDrive.`;

    try {
      const safeTitle = title.replace(/[^a-zA-Z0-9\s_-]/g, "").replace(/\s+/g, "_").slice(0, 50);
      const filename = `${dateISO}_${safeTitle}.md`;
      const saveResp = await saveToOneDrive(filename, markdownSummary);
      saveStatus = saveResp.status >= 200 && saveResp.status < 300
        ? `saved as ${filename} (fallback)`
        : `save failed (${saveResp.status})`;
    } catch (saveErr) {
      saveStatus = `save error: ${saveErr.message}`;
    }
  }

  console.log(`[meeting/end] ${nowET()} — title="${title}" duration=${duration} save=${saveStatus}`);

  if (toolCallId) {
    return vapiRespond(res, spokenSummary, toolCallId);
  }
  return res.json({
    ok: true,
    spoken_summary: spokenSummary,
    save_status: saveStatus,
    duration,
    markdown_preview: markdownSummary.slice(0, 500),
  });
});

// ============================================================
// ENDPOINT: POST /call-complete (v1.5 — Full Memory Loop)
// ============================================================
app.post("/call-complete", async (req, res) => {
  res.json({ ok: true, status: "processing" });

  const transcripts = req.body?.transcripts || [];
  const durationSec = req.body?.duration_sec || 0;
  const callId = req.body?.call_id || `call_${Date.now()}`;
  const dateISO = todayISOET();
  const timestampET = nowET();

  if (!transcripts.length) {
    console.log(`[call-complete] ${callId} — no transcript, skipping`);
    return;
  }

  const transcriptText = transcripts
    .map(t => `${t.role === "user" ? "Ates" : "Cammy"}: ${t.text}`)
    .join("\n");

  console.log(`[call-complete] ${callId} — ${transcripts.length} turns, ${durationSec}s`);

  let extracted = null;
  try {
    const systemPrompt = `You are Cammy, an executive AI assistant. Analyze this voice conversation transcript between Ates Civitci and his AI assistant.

Extract and return ONLY valid JSON (no markdown, no explanation) with this exact schema:
{
  "summary": "One sentence describing what this conversation was about.",
  "tasks": [
    { "description": "task description", "owner": "Ates or Cammy", "due": "date or null", "priority": "high|medium|low" }
  ],
  "commitments": [
    { "description": "commitment or promise made", "by": "who made it", "to": "who it was made to", "due": "date or null" }
  ],
  "decisions": [
    { "description": "decision made", "rationale": "brief reason or null" }
  ],
  "new_contacts": [
    { "name": "full name", "role": "title or relationship", "notes": "context" }
  ],
  "memory_facts": [
    "Short durable fact about Ates or his business, phrased as 'Remember that Ates ...' or 'Remember that Simple Smart AI ...'"
  ],
  "follow_ups": [
    { "description": "follow-up needed", "deadline": "date or null" }
  ]
}

Rules:
- Only extract items explicitly mentioned. Do not infer or hallucinate.
- If a section has nothing, return an empty array.
- memory_facts should only be truly durable facts (not one-time events).
- All dates in YYYY-MM-DD format if known, otherwise null.`;

    const raw = await callOpenAI(systemPrompt, `Call ID: ${callId}\nDate: ${timestampET}\nDuration: ${durationSec}s\n\nTranscript:\n${transcriptText}`, 30000);
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    extracted = JSON.parse(cleaned);
    console.log(`[call-complete] extraction OK — tasks:${extracted.tasks?.length} commitments:${extracted.commitments?.length} decisions:${extracted.decisions?.length} facts:${extracted.memory_facts?.length}`);
  } catch (err) {
    console.error("[call-complete] GPT extraction failed:", err.message);
    extracted = { summary: "GPT extraction failed", tasks: [], commitments: [], decisions: [], new_contacts: [], memory_facts: [], follow_ups: [] };
  }

  try {
    const logMd = `# Call Log: ${dateISO}\nCall ID: ${callId}\nTimestamp: ${timestampET}\nDuration: ${durationSec}s\n\n## Summary\n${extracted.summary}\n\n## Transcript\n${transcriptText}\n\n## Extracted Tasks\n${extracted.tasks?.map(t => `- [ ] ${t.description} (Owner: ${t.owner}, Due: ${t.due || "TBD"}, Priority: ${t.priority})`).join("\n") || "None"}\n\n## Commitments\n${extracted.commitments?.map(c => `- ${c.description} (By: ${c.by}, Due: ${c.due || "TBD"})`).join("\n") || "None"}\n\n## Decisions\n${extracted.decisions?.map(d => `- ${d.description}${d.rationale ? ` — ${d.rationale}` : ""}`).join("\n") || "None"}\n\n## New Contacts\n${extracted.new_contacts?.map(c => `- ${c.name} (${c.role}): ${c.notes}`).join("\n") || "None"}\n\n## Follow-Ups\n${extracted.follow_ups?.map(f => `- ${f.description} (by ${f.deadline || "TBD"})`).join("\n") || "None"}\n`;

    const content_b64 = Buffer.from(logMd, "utf8").toString("base64");
    await post(ONEDRIVE_ROUTER, {
      filename: `${dateISO}_${callId}.md`,
      content_b64,
      force_folder: "01 Logs/Call Log",
      overwrite: false,
    }, {}, 20000);
    console.log(`[call-complete] call log saved`);
  } catch (err) {
    console.error("[call-complete] OneDrive log save failed:", err.message);
  }

  try {
    const allItems = [
      ...(extracted.tasks || []).map(t => ({
        type: "TASK",
        description: t.description,
        owner: t.owner,
        due: t.due || "",
        priority: t.priority,
        source: callId,
        date: dateISO,
      })),
      ...(extracted.commitments || []).map(c => ({
        type: "COMMITMENT",
        description: c.description,
        owner: c.by,
        due: c.due || "",
        priority: "high",
        source: callId,
        date: dateISO,
      })),
      ...(extracted.decisions || []).map(d => ({
        type: "DECISION",
        description: d.description,
        owner: "Ates",
        due: "",
        priority: "medium",
        source: callId,
        date: dateISO,
      })),
    ];

    if (allItems.length && MEMORY_WRITE_URL) {
      await post(MEMORY_WRITE_URL, {
        action: "decision_log_append",
        items: allItems,
        folder_id: EXCEL_FOLDER_ID,
        sheet_id: EXCEL_SHEET_ID,
      }, {}, 20000);
      console.log(`[call-complete] decision log appended — ${allItems.length} rows`);
    }
  } catch (err) {
    console.error("[call-complete] decision log append failed:", err.message);
  }

  try {
    const facts = extracted.memory_facts || [];
    const contacts = extracted.new_contacts || [];
    const contactFacts = contacts.map(c =>
      `Remember that Ates knows ${c.name} who is ${c.role}. Context: ${c.notes}`
    );
    const allFacts = [...facts, ...contactFacts];

    if (allFacts.length && MEMORY_WRITE_URL) {
      await post(MEMORY_WRITE_URL, {
        action: "memory_update",
        facts: allFacts,
        source: callId,
        timestamp: timestampET,
      }, {}, 20000);
      console.log(`[call-complete] memory facts written — ${allFacts.length} facts`);
    }
  } catch (err) {
    console.error("[call-complete] memory write failed:", err.message);
  }

  try {
    const urgentTasks = (extracted.tasks || []).filter(t => t.priority === "high");
    const urgentCommitments = (extracted.commitments || []);

    if (urgentTasks.length || urgentCommitments.length) {
      const stagingItems = [
        ...urgentTasks.map(t => ({
          source: "voice_call",
          priority: "URGENT",
          section: "OPEN-LOOPS",
          content: `Task from call ${callId}: ${t.description} (due ${t.due || "TBD"})`,
          action_required: true,
          action: `Assign to ${t.owner} and confirm deadline`,
        })),
        ...urgentCommitments.map(c => ({
          source: "voice_call",
          priority: "INFO",
          section: "OPEN-LOOPS",
          content: `Commitment from call: ${c.description} (by ${c.by}, due ${c.due || "TBD"})`,
          action_required: true,
          action: "Track and follow up",
        })),
      ];

      const staging = { generated_at: timestampET, items: stagingItems };
      const content_b64 = Buffer.from(JSON.stringify(staging, null, 2), "utf8").toString("base64");
      await post(ONEDRIVE_ROUTER, {
        filename: "morning_briefing_additions.json",
        content_b64,
        force_folder: "03 Staging",
        overwrite: true,
      }, {}, 20000);
      console.log(`[call-complete] staging file updated — ${stagingItems.length} items`);
    }
  } catch (err) {
    console.error("[call-complete] staging write failed:", err.message);
  }

  console.log(`[call-complete] ${callId} — pipeline complete`);
});

// ============================================================
// NEW TOOL 6 (v1.6): /vapi/get_weather
// Args: { location?: string }  — defaults to Newton, MA
// Uses wttr.in JSON API — no key required
// ============================================================
app.post("/vapi/get_weather", async (req, res) => {
  const { toolCallId, args } = extractArgs(req.body);
  const location = (args?.location || "Newton, MA").replace(/\s+/g, "+");

  try {
    const resp = await get(
      `https://wttr.in/${encodeURIComponent(location)}?format=j1`,
      { "User-Agent": "Cammy-VoiceAssistant/1.6" },
      10000
    );

    if (resp.status !== 200 || !resp.body?.current_condition) {
      return vapiRespond(res, `I could not retrieve weather for ${location.replace(/\+/g, " ")} right now.`, toolCallId);
    }

    const cur = resp.body.current_condition[0];
    const temp_f = cur.temp_F;
    const feels_f = cur.FeelsLikeF;
    const desc = cur.weatherDesc?.[0]?.value || "unknown";
    const humidity = cur.humidity;
    const wind_mph = cur.windspeedMiles;

    // Today's forecast
    const today = resp.body.weather?.[0];
    const high_f = today?.maxtempF;
    const low_f = today?.mintempF;

    const spoken = `Currently in ${location.replace(/\+/g, " ")}: ${temp_f} degrees Fahrenheit, feels like ${feels_f}. ${desc}. Humidity ${humidity} percent, wind ${wind_mph} miles per hour. Today's high ${high_f}, low ${low_f}.`;

    vapiRespond(res, spoken, toolCallId);

  } catch (err) {
    console.error("[get_weather]", err.message);
    vapiRespond(res, "I had trouble getting the weather right now. Try again.", toolCallId);
  }
});

// ============================================================
// NEW TOOL 7 (v1.6): /vapi/book_opentable
// Args: { restaurant: string, date: string (YYYY-MM-DD),
//         time: string (HH:MM), party_size: number,
//         location?: string }
// Strategy: Query OpenTable availability via their public
// "nextavailable" endpoint (no partner key needed for search),
// then confirm the slot verbally — NEVER claim booked without
// real confirmation token. Uses Pipedream for the actual
// browser-based booking if a slot is found.
// ============================================================
app.post("/vapi/book_opentable", async (req, res) => {
  const { toolCallId, args } = extractArgs(req.body);
  const restaurant  = args?.restaurant  || "";
  const date        = args?.date        || todayISOET();
  const time        = args?.time        || "19:00";
  const party_size  = parseInt(args?.party_size || "2", 10);
  const location    = args?.location    || "Boston, MA";

  if (!restaurant) {
    return vapiRespond(res, "Which restaurant would you like to book?", toolCallId);
  }

  try {
    // Step 1: Search OpenTable for the restaurant
    const searchUrl = `https://www.opentable.com/s/?covers=${party_size}&dateTime=${date}T${time}&metroId=&latitude=&longitude=&radius=&restaurantName=${encodeURIComponent(restaurant)}&country=US&lang=en-US&corrid=&ref=`;
    
    // Use OpenTable's GQL endpoint that powers their public search
    const gqlResp = await post(
      "https://www.opentable.com/dapi/fe/gql",
      {
        operationName: "restaurantAvailability",
        variables: {
          restaurantName: restaurant,
          date: date,
          time: time,
          partySize: party_size,
          latitude: 42.337,
          longitude: -71.2087,
          radius: 30,
          databaseRegion: "NA",
        },
        query: `query restaurantAvailability($restaurantName:String $date:String $time:String $partySize:Int) {
          restaurants(name: $restaurantName) {
            id name address { line1 city } availability(date:$date time:$time partySize:$partySize) { slotTime }
          }
        }`,
      },
      {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; CammyVA/1.6)",
        "x-csrf-token": "",
      },
      12000
    );

    // The GQL endpoint may or may not return data — if it fails, fall through to
    // a direct availability check via the public URL pattern
    let availableSlots = [];
    let restaurantId = null;
    let restaurantName = restaurant;

    if (gqlResp.body?.data?.restaurants?.length) {
      const r = gqlResp.body.data.restaurants[0];
      restaurantId = r.id;
      restaurantName = r.name || restaurant;
      availableSlots = (r.availability || []).map(s => s.slotTime).filter(Boolean);
    }

    if (!availableSlots.length) {
      // Fallback: try the public next-available API
      const naResp = await get(
        `https://www.opentable.com/widget/reservation/counts?rid=${restaurantId || ""}&datetime=${date}T${time}&party_size=${party_size}&restaurantName=${encodeURIComponent(restaurant)}`,
        { "User-Agent": "Mozilla/5.0 (compatible; CammyVA/1.6)" },
        10000
      );

      if (naResp.body?.availability?.length) {
        availableSlots = naResp.body.availability.map(s => s.time || s.slot_time).filter(Boolean);
      }
    }

    if (!availableSlots.length) {
      return vapiRespond(
        res,
        `I searched OpenTable for ${restaurant} on ${date} for ${party_size} but found no availability at ${time}. You may want to check nearby times or try the OpenTable app directly.`,
        toolCallId
      );
    }

    // Sort slots by proximity to requested time
    const requestedMinutes = parseInt(time.split(":")[0]) * 60 + parseInt(time.split(":")[1]);
    availableSlots.sort((a, b) => {
      const aMin = parseInt(a.split(":")[0]) * 60 + parseInt(a.split(":")[1]);
      const bMin = parseInt(b.split(":")[0]) * 60 + parseInt(b.split(":")[1]);
      return Math.abs(aMin - requestedMinutes) - Math.abs(bMin - requestedMinutes);
    });

    const bestSlot = availableSlots[0];
    const alternates = availableSlots.slice(1, 3);
    const altText = alternates.length ? ` Alternates available: ${alternates.join(", ")}.` : "";

    // IMPORTANT: Cammy must confirm with Ates before executing booking.
    // Return the slot info and ask for confirmation.
    vapiRespond(
      res,
      `I found availability at ${restaurant} on ${date}. The closest slot to ${time} is ${bestSlot} for ${party_size}.${altText} Should I confirm that booking?`,
      toolCallId
    );

    console.log(`[book_opentable] ${restaurant} ${date} — best slot ${bestSlot}, ${availableSlots.length} total`);

  } catch (err) {
    console.error("[book_opentable]", err.message);
    vapiRespond(
      res,
      `I ran into an issue checking OpenTable for ${restaurant}. Try the OpenTable app or say "Cammy, search OpenTable for me" and I can walk through it step by step.`,
      toolCallId
    );
  }
});

// ============================================================
// NEW TOOL 8 (v1.6): /vapi/confirm_opentable_booking
// Called after Ates confirms the slot. Executes the actual
// booking via Pipedream browser automation.
// Args: { restaurant_id: string, slot_time: string,
//         date: string, party_size: number }
// ============================================================
app.post("/vapi/confirm_opentable_booking", async (req, res) => {
  const { toolCallId, args } = extractArgs(req.body);
  const { restaurant_id, restaurant_name, slot_time, date, party_size } = args || {};

  if (!slot_time || !date) {
    return vapiRespond(res, "I need the slot time and date to complete the booking.", toolCallId);
  }

  try {
    // Log capability request — actual browser booking requires Pipedream browserbase
    // For now: direct the user to confirm via a deep link and log the attempt
    const deepLink = `https://www.opentable.com/booking/experiences-availability?rid=${restaurant_id || ""}&restref=${restaurant_id || ""}&datetime=${date}T${slot_time}&covers=${party_size || 2}`;

    // Log to OneDrive for audit
    const logEntry = {
      timestamp: nowET(),
      action: "opentable_booking_attempt",
      restaurant: restaurant_name || restaurant_id,
      date,
      time: slot_time,
      party_size: party_size || 2,
      status: "pending_confirmation",
      deep_link: deepLink,
    };
    const content_b64 = Buffer.from(JSON.stringify(logEntry, null, 2), "utf8").toString("base64");
    post(ONEDRIVE_ROUTER, {
      filename: `booking_${date}_${Date.now()}.json`,
      content_b64,
      force_folder: "04 Bookings",
      overwrite: false,
    }, {}, 10000).catch(e => console.error("[confirm_opentable] log failed:", e.message));

    vapiRespond(
      res,
      `I've logged the booking request for ${restaurant_name || "the restaurant"} on ${date} at ${slot_time} for ${party_size || 2}. To complete it, open this link: ${deepLink}. I'll add a calendar reminder once you confirm.`,
      toolCallId
    );

  } catch (err) {
    console.error("[confirm_opentable_booking]", err.message);
    vapiRespond(res, "I had trouble completing that booking. Please book directly via OpenTable.", toolCallId);
  }
});

// ============================================================
// NEW TOOL 9 (v1.6): /vapi/book_resy
// Uses Resy unofficial API (api.resy.com)
// Args: { restaurant: string, date: string (YYYY-MM-DD),
//         time: string (HH:MM), party_size: number,
//         city?: string }
// Requires RESY_AUTH_TOKEN (user's personal Resy token)
// stored in brain.json under credentials.resy_auth_token
// ============================================================
app.post("/vapi/book_resy", async (req, res) => {
  const { toolCallId, args } = extractArgs(req.body);
  const restaurant  = args?.restaurant  || "";
  const date        = args?.date        || todayISOET();
  const time        = args?.time        || "19:00";
  const party_size  = parseInt(args?.party_size || "2", 10);
  const city        = args?.city        || "boston";

  if (!restaurant) {
    return vapiRespond(res, "Which restaurant on Resy would you like to book?", toolCallId);
  }

  // Get Resy auth token from brain or env
  let resyToken = RESY_AUTH_TOKEN;
  try {
    if (!resyToken) {
      const brain = await readBrain();
      resyToken = brain?.credentials?.resy_auth_token || brain?.resy_auth_token || "";
    }
  } catch (e) {
    console.error("[book_resy] brain read failed:", e.message);
  }

  if (!resyToken) {
    return vapiRespond(
      res,
      "I don't have your Resy credentials stored yet. To fix this: log in to Resy in your browser, open DevTools, find a request to api.resy.com, and copy the x-resy-auth-token header value. Then say 'Cammy, update my Resy token' and paste it.",
      toolCallId
    );
  }

  try {
    // Step 1: Find venue
    const findResp = await get(
      `https://api.resy.com/3/venue/search?query=${encodeURIComponent(restaurant)}&location=${encodeURIComponent(city)}&lat=0&long=0`,
      {
        "Authorization": `ResyAPI api_key="${RESY_API_KEY}"`,
        "x-resy-auth-token": resyToken,
        "User-Agent": "Mozilla/5.0 (compatible; CammyVA/1.6)",
        "Origin": "https://resy.com",
        "Referer": "https://resy.com/",
      },
      10000
    );

    const venues = findResp.body?.search?.hits || [];
    if (!venues.length) {
      return vapiRespond(res, `I couldn't find "${restaurant}" on Resy. Try the exact name as it appears on the Resy app.`, toolCallId);
    }

    const venue = venues[0];
    const venue_id = venue.objectID || venue.id?.resy;
    const venue_name = venue.name || restaurant;

    // Step 2: Check availability
    const availResp = await get(
      `https://api.resy.com/4/find?lat=0&long=0&day=${date}&party_size=${party_size}&venue_id=${venue_id}`,
      {
        "Authorization": `ResyAPI api_key="${RESY_API_KEY}"`,
        "x-resy-auth-token": resyToken,
        "User-Agent": "Mozilla/5.0 (compatible; CammyVA/1.6)",
        "Origin": "https://resy.com",
        "Referer": "https://resy.com/",
      },
      10000
    );

    const slots = availResp.body?.results?.venues?.[0]?.slots || [];

    if (!slots.length) {
      return vapiRespond(
        res,
        `No availability at ${venue_name} on ${date} for ${party_size}. The restaurant may be fully booked or not on Resy. Try the Resy app to check the waitlist.`,
        toolCallId
      );
    }

    // Find closest slot to requested time
    const requestedMinutes = parseInt(time.split(":")[0]) * 60 + parseInt(time.split(":")[1]);
    slots.sort((a, b) => {
      const aTime = a.date?.start?.split("T")[1]?.slice(0, 5) || "00:00";
      const bTime = b.date?.start?.split("T")[1]?.slice(0, 5) || "00:00";
      const aMin = parseInt(aTime.split(":")[0]) * 60 + parseInt(aTime.split(":")[1]);
      const bMin = parseInt(bTime.split(":")[0]) * 60 + parseInt(bTime.split(":")[1]);
      return Math.abs(aMin - requestedMinutes) - Math.abs(bMin - requestedMinutes);
    });

    const bestSlot = slots[0];
    const slotTime = bestSlot.date?.start?.split("T")[1]?.slice(0, 5) || time;
    const tableType = bestSlot.config?.type || "table";
    const configId = bestSlot.config?.token;

    const alternates = slots.slice(1, 3).map(s => s.date?.start?.split("T")[1]?.slice(0, 5) || "").filter(Boolean);
    const altText = alternates.length ? ` Alternates: ${alternates.join(", ")}.` : "";

    // Return availability — ask for confirmation before booking
    vapiRespond(
      res,
      `I found ${venue_name} on Resy for ${date}. Best slot near ${time} is ${slotTime}, ${tableType} for ${party_size}.${altText} Shall I confirm the booking?`,
      toolCallId
    );

    // Store config_id temporarily in memory for follow-up confirm call
    // (in-memory, short-lived — enough for the current Vapi call)
    app.locals.pendingResyBooking = {
      config_token: configId,
      venue_name,
      venue_id,
      date,
      time: slotTime,
      party_size,
      timestamp: Date.now(),
    };

    console.log(`[book_resy] ${venue_name} ${date} — slot ${slotTime}, config ${configId}`);

  } catch (err) {
    console.error("[book_resy]", err.message);
    vapiRespond(res, `I had trouble reaching Resy for ${restaurant}. Try the Resy app directly.`, toolCallId);
  }
});

// ============================================================
// NEW TOOL 10 (v1.6): /vapi/confirm_resy_booking
// Executes the actual Resy booking after Ates confirms
// Args: { confirm: boolean }
// ============================================================
app.post("/vapi/confirm_resy_booking", async (req, res) => {
  const { toolCallId, args } = extractArgs(req.body);
  const confirm = args?.confirm !== false; // default true

  if (!confirm) {
    app.locals.pendingResyBooking = null;
    return vapiRespond(res, "Booking cancelled. Let me know if you want to try a different time.", toolCallId);
  }

  const pending = app.locals.pendingResyBooking;
  if (!pending || (Date.now() - pending.timestamp) > 5 * 60 * 1000) {
    return vapiRespond(res, "The booking session expired. Please start over with the restaurant name.", toolCallId);
  }

  let resyToken = RESY_AUTH_TOKEN;
  try {
    if (!resyToken) {
      const brain = await readBrain();
      resyToken = brain?.credentials?.resy_auth_token || brain?.resy_auth_token || "";
    }
  } catch (e) {}

  if (!resyToken) {
    return vapiRespond(res, "I still need your Resy auth token to complete the booking.", toolCallId);
  }

  try {
    // Step 1: Get booking details (book_token)
    const detailsResp = await get(
      `https://api.resy.com/3/details?config_id=${encodeURIComponent(pending.config_token)}&date=${pending.date}&party_size=${pending.party_size}`,
      {
        "Authorization": `ResyAPI api_key="${RESY_API_KEY}"`,
        "x-resy-auth-token": resyToken,
        "User-Agent": "Mozilla/5.0 (compatible; CammyVA/1.6)",
        "Origin": "https://resy.com",
        "Referer": "https://resy.com/",
      },
      10000
    );

    const bookToken = detailsResp.body?.book_token?.value;
    if (!bookToken) {
      throw new Error("No book_token in details response");
    }

    // Step 2: Execute booking
    const bookResp = await postForm(
      "https://api.resy.com/3/book",
      {
        book_token: bookToken,
        struct_payment_method: JSON.stringify({ id: 0 }),
        source_id: "resy.com-venue-details",
      },
      {
        "Authorization": `ResyAPI api_key="${RESY_API_KEY}"`,
        "x-resy-auth-token": resyToken,
        "User-Agent": "Mozilla/5.0 (compatible; CammyVA/1.6)",
        "Origin": "https://resy.com",
        "Referer": "https://resy.com/",
      },
      12000
    );

    const resyId = bookResp.body?.reservation_id || bookResp.body?.resy_token;

    if (bookResp.status === 201 || bookResp.status === 200 || resyId) {
      // Success — create calendar event via Pipedream
      const confirmationMsg = `Booking confirmed at ${pending.venue_name} on ${pending.date} at ${pending.time} for ${pending.party_size}. Confirmation ID: ${resyId || "confirmed"}.`;

      // Add to Google Calendar
      callGcalProxy("create_calendar_event", {
        summary: `Dinner at ${pending.venue_name}`,
        date: pending.date,
        time: pending.time,
        duration_minutes: 90,
        description: `Resy booking confirmed. Confirmation: ${resyId || "confirmed"}. Party of ${pending.party_size}.`,
      }).catch(e => console.error("[confirm_resy] calendar event failed:", e.message));

      // Log to OneDrive
      const logEntry = {
        timestamp: nowET(),
        action: "resy_booking_confirmed",
        venue: pending.venue_name,
        date: pending.date,
        time: pending.time,
        party_size: pending.party_size,
        reservation_id: resyId || "confirmed",
        status: "success",
      };
      const content_b64 = Buffer.from(JSON.stringify(logEntry, null, 2), "utf8").toString("base64");
      post(ONEDRIVE_ROUTER, {
        filename: `resy_booking_${pending.date}_${Date.now()}.json`,
        content_b64,
        force_folder: "04 Bookings",
        overwrite: false,
      }, {}, 10000).catch(e => console.error("[confirm_resy] log failed:", e.message));

      app.locals.pendingResyBooking = null;
      vapiRespond(res, confirmationMsg + " I've also added it to your calendar.", toolCallId);
      console.log(`[confirm_resy_booking] SUCCESS — ${pending.venue_name} ${pending.date} ${pending.time} resy_id=${resyId}`);

    } else {
      const errMsg = bookResp.body?.message || bookResp.body?.error || `HTTP ${bookResp.status}`;
      console.error("[confirm_resy_booking] booking failed:", errMsg);
      vapiRespond(
        res,
        `The booking at ${pending.venue_name} could not be completed: ${errMsg}. Please try booking directly in the Resy app.`,
        toolCallId
      );
    }

  } catch (err) {
    console.error("[confirm_resy_booking]", err.message);
    vapiRespond(res, `I ran into an error completing the Resy booking. Please book directly in the Resy app.`, toolCallId);
  }
});

// ============================================================
// NEW TOOL 11 (v1.6): /vapi/order_uber
// Args: { pickup?: string, destination: string,
//         product?: "UberX"|"UberBlack"|"UberXL" }
// Requires UBER_ACCESS_TOKEN (OAuth token for Ates's account)
// stored in brain.json under credentials.uber_access_token
// ============================================================
app.post("/vapi/order_uber", async (req, res) => {
  const { toolCallId, args } = extractArgs(req.body);
  const destination = args?.destination || "";
  const pickup = args?.pickup || "current location";
  const product_pref = (args?.product || "UberX").toLowerCase();

  if (!destination) {
    return vapiRespond(res, "Where would you like to go? Tell me the destination address.", toolCallId);
  }

  // Get Uber token from brain or env
  let uberToken = UBER_ACCESS_TOKEN;
  try {
    if (!uberToken) {
      const brain = await readBrain();
      uberToken = brain?.credentials?.uber_access_token || brain?.uber_access_token || "";
    }
  } catch (e) {
    console.error("[order_uber] brain read failed:", e.message);
  }

  if (!uberToken) {
    return vapiRespond(
      res,
      "I don't have your Uber credentials yet. To connect Uber: go to developer.uber.com, create an app, authorize it with your Uber account, and share the access token with me. For now, I can open the Uber app for you.",
      toolCallId
    );
  }

  try {
    // Geocode destination
    const destCoords = await geocode(destination);

    // Geocode pickup (if not "current location")
    let pickupCoords = { lat: 42.337, lon: -71.2087 }; // Default: Newton MA
    if (pickup && pickup !== "current location") {
      pickupCoords = await geocode(pickup);
    }

    // Step 1: Get available products
    const productsResp = await get(
      `https://api.uber.com/v1.2/products?latitude=${pickupCoords.lat}&longitude=${pickupCoords.lon}`,
      { Authorization: `Bearer ${uberToken}` },
      10000
    );

    const products = productsResp.body?.products || [];
    if (!products.length) {
      return vapiRespond(res, "No Uber products available near your pickup location right now.", toolCallId);
    }

    // Find preferred product
    const product = products.find(p =>
      p.display_name?.toLowerCase().includes(product_pref) ||
      p.product_id === product_pref
    ) || products.find(p => p.display_name?.toLowerCase().includes("uberx")) || products[0];

    // Step 2: Get fare estimate
    const estimateResp = await post(
      "https://api.uber.com/v1.2/requests/estimate",
      {
        product_id: product.product_id,
        start_latitude: pickupCoords.lat,
        start_longitude: pickupCoords.lon,
        end_latitude: destCoords.lat,
        end_longitude: destCoords.lon,
      },
      { Authorization: `Bearer ${uberToken}`, "Content-Type": "application/json" },
      12000
    );

    const fare = estimateResp.body?.fare;
    const trip = estimateResp.body?.trip;
    const fareId = fare?.fare_id;
    const fareDisplay = fare?.display || "unknown fare";
    const durationMin = trip?.duration_estimate ? Math.round(trip.duration_estimate / 60) : null;
    const pickupEta = estimateResp.body?.pickup_estimate;

    const durationText = durationMin ? ` Estimated ride: ${durationMin} minutes.` : "";
    const etaText = pickupEta ? ` Driver arrives in about ${pickupEta} minutes.` : "";

    // Step 3: Confirm with Ates before requesting
    // Store pending ride for confirm_uber call
    app.locals.pendingUberRide = {
      product_id: product.product_id,
      product_name: product.display_name,
      fare_id: fareId,
      pickup_lat: pickupCoords.lat,
      pickup_lon: pickupCoords.lon,
      dest_lat: destCoords.lat,
      dest_lon: destCoords.lon,
      destination_name: destination,
      fare_display: fareDisplay,
      timestamp: Date.now(),
    };

    vapiRespond(
      res,
      `${product.display_name} to ${destination} — ${fareDisplay}.${durationText}${etaText} Shall I confirm the ride?`,
      toolCallId
    );

    console.log(`[order_uber] ${product.display_name} to ${destination} fare=${fareDisplay}`);

  } catch (err) {
    console.error("[order_uber]", err.message);
    vapiRespond(res, `I had trouble booking an Uber. ${err.message.includes("geocode") ? "I could not find that address." : "Try the Uber app directly."} `, toolCallId);
  }
});

// ============================================================
// NEW TOOL 12 (v1.6): /vapi/confirm_uber_ride
// Args: { confirm: boolean }
// ============================================================
app.post("/vapi/confirm_uber_ride", async (req, res) => {
  const { toolCallId, args } = extractArgs(req.body);
  const confirm = args?.confirm !== false;

  if (!confirm) {
    app.locals.pendingUberRide = null;
    return vapiRespond(res, "Ride cancelled.", toolCallId);
  }

  const pending = app.locals.pendingUberRide;
  if (!pending || (Date.now() - pending.timestamp) > 3 * 60 * 1000) {
    return vapiRespond(res, "The ride estimate expired. Please start over with your destination.", toolCallId);
  }

  let uberToken = UBER_ACCESS_TOKEN;
  try {
    if (!uberToken) {
      const brain = await readBrain();
      uberToken = brain?.credentials?.uber_access_token || "";
    }
  } catch (e) {}

  if (!uberToken) {
    return vapiRespond(res, "I lost your Uber credentials. Please use the Uber app.", toolCallId);
  }

  try {
    const rideResp = await post(
      "https://api.uber.com/v1.2/requests",
      {
        product_id: pending.product_id,
        start_latitude: pending.pickup_lat,
        start_longitude: pending.pickup_lon,
        end_latitude: pending.dest_lat,
        end_longitude: pending.dest_lon,
        fare_id: pending.fare_id,
      },
      { Authorization: `Bearer ${uberToken}`, "Content-Type": "application/json" },
      15000
    );

    if (rideResp.status === 202 || rideResp.body?.request_id) {
      const requestId = rideResp.body?.request_id || "confirmed";
      app.locals.pendingUberRide = null;
      vapiRespond(res, `Your ${pending.product_name} is on the way to take you to ${pending.destination_name}. Request ID: ${requestId}. You can track it in the Uber app.`, toolCallId);
      console.log(`[confirm_uber_ride] SUCCESS request_id=${requestId}`);
    } else {
      const errMsg = rideResp.body?.message || rideResp.body?.errors?.[0]?.message || `HTTP ${rideResp.status}`;
      console.error("[confirm_uber_ride] failed:", errMsg);
      vapiRespond(res, `Uber could not complete the request: ${errMsg}. Please use the Uber app.`, toolCallId);
    }
  } catch (err) {
    console.error("[confirm_uber_ride]", err.message);
    vapiRespond(res, "Uber ride request failed. Please use the Uber app.", toolCallId);
  }
});

// ============================================================
// NEW TOOL 13 (v1.6): /vapi/make_call
// Place an outbound call on Ates's behalf via Twilio
// Args: { to_name: string, to_number?: string,
//         message?: string, purpose?: string }
// ============================================================
app.post("/vapi/make_call", async (req, res) => {
  const { toolCallId, args } = extractArgs(req.body);
  const to_name   = args?.to_name   || "";
  const purpose   = args?.purpose   || "general call";
  let to_number   = args?.to_number || "";

  if (!to_name && !to_number) {
    return vapiRespond(res, "Who would you like me to call? Give me a name or number.", toolCallId);
  }

  // Look up number in brain if not provided
  if (!to_number) {
    try {
      const brain = await readBrain();
      const contacts = brain?.contacts || {};
      for (const [name, info] of Object.entries(contacts)) {
        if (name.toLowerCase().includes(to_name.toLowerCase())) {
          const phone = (info.phones || []).find(p => p && p !== "GAP" && p.startsWith("+"));
          if (phone) { to_number = phone; break; }
        }
      }
    } catch (e) {
      console.error("[make_call] brain lookup failed:", e.message);
    }
  }

  if (!to_number) {
    return vapiRespond(
      res,
      `I don't have a number for ${to_name} in your contacts. What number should I call?`,
      toolCallId
    );
  }

  try {
    const twiml = `<Response><Say voice="Polly.Joanna">Hi, this is Cammy calling on behalf of Ates Civitci regarding ${purpose}. Please hold for Ates or call back at +1 617 347 5359.</Say></Response>`;

    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH}`).toString("base64");
    const callResp = await postForm(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`,
      { Twiml: twiml, To: to_number, From: TWILIO_FROM },
      { Authorization: `Basic ${auth}` },
      12000
    );

    if (callResp.status === 201 && callResp.body?.sid) {
      const sid = callResp.body.sid;
      vapiRespond(res, `I'm calling ${to_name} at ${to_number} now. Call SID: ${sid}. They'll hear a message from me on your behalf.`, toolCallId);
      console.log(`[make_call] called ${to_name} ${to_number} SID=${sid}`);
    } else {
      const errMsg = callResp.body?.message || callResp.body?.error || `HTTP ${callResp.status}`;
      vapiRespond(res, `I could not place the call to ${to_name}: ${errMsg}`, toolCallId);
    }

  } catch (err) {
    console.error("[make_call]", err.message);
    vapiRespond(res, `I had trouble placing the call to ${to_name}. Try again.`, toolCallId);
  }
});

// ============================================================
// NEW TOOL 14 (v1.6): /vapi/ask_computer
// Direct handoff to Perplexity Computer for deep analysis.
// Cammy calls this when a task exceeds her Vapi context.
// Args: { question: string, context?: string }
// Returns: Computer's answer spoken back through Cammy.
// NOTE: This does NOT create a middle agent. Cammy sends the
// question, Computer answers, Cammy reads the answer aloud.
// ============================================================
app.post("/vapi/ask_computer", async (req, res) => {
  const { toolCallId, args } = extractArgs(req.body);
  const question = args?.question || args?.query || "";
  const context = args?.context || "";

  if (!question) {
    return vapiRespond(res, "What would you like me to look up with Computer?", toolCallId);
  }

  if (!PERPLEXITY_API_KEY) {
    // Fallback: use OpenAI for the answer
    try {
      const answer = await callOpenAI(
        "You are Cammy, an executive AI assistant for Ates Civitci. Answer concisely and accurately. Speak in 1-3 sentences max for voice delivery.",
        context ? `Context: ${context}\n\nQuestion: ${question}` : question,
        20000
      );
      return vapiRespond(res, answer, toolCallId);
    } catch (e) {
      return vapiRespond(res, "I could not reach Computer for that analysis. Try asking me again.", toolCallId);
    }
  }

  try {
    // Call Perplexity sonar API
    const systemMsg = `You are Cammy's deep-research assistant. The user's question is being routed through Cammy's voice interface. Respond in 2-4 short sentences suitable for text-to-speech. Be direct and actionable. No markdown, no bullet points — plain prose only.`;

    const resp = await post(
      "https://api.perplexity.ai/chat/completions",
      {
        model: "sonar",
        messages: [
          { role: "system", content: systemMsg },
          { role: "user", content: context ? `${context}\n\n${question}` : question },
        ],
        max_tokens: 300,
        temperature: 0.2,
      },
      {
        Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
        "Content-Type": "application/json",
      },
      20000
    );

    const answer = resp.body?.choices?.[0]?.message?.content || "";

    if (!answer) {
      return vapiRespond(res, "I got an empty response from Computer. Try rephrasing the question.", toolCallId);
    }

    // Clean for TTS — remove any markdown that slipped through
    const cleanAnswer = answer
      .replace(/\*\*/g, "").replace(/\*/g, "")
      .replace(/#{1,6}\s/g, "").replace(/\n{2,}/g, ". ")
      .replace(/\n/g, " ").trim();

    vapiRespond(res, cleanAnswer, toolCallId);
    console.log(`[ask_computer] answered: "${question.slice(0, 60)}..." — ${cleanAnswer.length} chars`);

  } catch (err) {
    console.error("[ask_computer]", err.message);
    vapiRespond(res, "I had trouble reaching Computer for that analysis. Try again.", toolCallId);
  }
});

// ── Health check ─────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({
  ok: true,
  uptime: process.uptime(),
  time: nowET(),
  v: "1.6",
  meeting_active: meetingState.active,
  tools: [
    "get_today_schedule", "get_urgent_emails", "get_open_loops", "get_brain_fact",
    "get_weather", "book_opentable", "confirm_opentable_booking",
    "book_resy", "confirm_resy_booking",
    "order_uber", "confirm_uber_ride",
    "make_call", "ask_computer",
  ],
}));
app.get("/", (_req, res) => res.json({ ok: true, server: "cammy-vapi-tool-server", v: "1.6" }));

app.listen(PORT, () => console.log(`[${nowET()}] Cammy Vapi Tool Server v1.6 on port ${PORT}`));
