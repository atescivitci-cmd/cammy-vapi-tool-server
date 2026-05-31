// ============================================================
// Cammy Vapi Tool Server v1.4
// Handles tool calls from Vapi during voice calls:
//   POST /vapi/get_today_schedule
//   POST /vapi/get_urgent_emails
//   POST /vapi/get_open_loops
//   POST /vapi/get_brain_fact
//   POST /onedrive/move          <-- v1.3: moves a file via Graph API
//   POST /meeting/start          <-- NEW v1.4: activates meeting listen mode
//   POST /meeting/end            <-- NEW v1.4: ends meeting, summarizes, saves to OneDrive
//
// Auth strategy (v1.2/v1.3 - no expiring tokens):
//   - Google Calendar / Gmail: proxied through PIPEDREAM_GCAL_URL
//     (a Pipedream HTTP endpoint that holds the permanent Google OAuth
//     connected account - never expires, no token refresh needed)
//   - OneDrive reads: via READ_ENDPOINT (existing Pipedream workflow)
//   - OneDrive moves: via ONEDRIVE_MOVE_URL (Pipedream workflow - holds Graph OAuth)
//   - OneDrive writes: via ONEDRIVE_ROUTER (Pipedream workflow)
// ============================================================

import express from "express";
import https from "https";
import http from "http";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ── Env vars ─────────────────────────────────────────────────
// PIPEDREAM_GCAL_URL: Pipedream endpoint that proxies Google Calendar/Gmail
const PIPEDREAM_GCAL_URL  = process.env.PIPEDREAM_GCAL_URL;
const ONEDRIVE_ROUTER     = process.env.ONEDRIVE_ROUTER  || "https://eoc09ly9stpskyz.m.pipedream.net";
const READ_ENDPOINT       = process.env.READ_ENDPOINT    || "https://eo54pqk9broiael.m.pipedream.net";
const BRAIN_ITEM_ID       = process.env.BRAIN_ITEM_ID    || "FD682E54F97FD13C!sfe87fab543a74c35a325354af330643e";
// NEW v1.3: Pipedream workflow that executes Graph API PATCH /move
const ONEDRIVE_MOVE_URL   = process.env.ONEDRIVE_MOVE_URL || "";
// NEW v1.4: OpenAI API key for meeting summarization
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY || "";

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

// ── Helper: ET formatting ─────────────────────────────────────
function todayISOET() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function nowET() {
  return new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
}

// ── Helper: proxy call to Pipedream Google endpoint ──────────
// Pipedream workflow receives { action, params } and returns { result }
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

// ============================================================
// TOOL 5 (NEW v1.3): /onedrive/move
// Moves a OneDrive file to a new parent folder via Pipedream proxy
// Body: { item_id, destination_folder_id, new_name? }
// Returns: { success, item_id, name, webUrl } or { error }
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
// MEETING LISTEN MODE (NEW v1.4)
// In-memory session state — one active meeting at a time
// ============================================================
let meetingState = {
  active: false,
  startTime: null,
  title: "Untitled Meeting",
  attendees: [],
};

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

// ============================================================
// ENDPOINT: POST /meeting/start
// Body: { title?, attendees? }
// Called when user says "Cammy, listen to this meeting"
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
// Body: { title?, attendees?, notes?, action_items? }
// Called when user says "Cammy, meeting done"
// ============================================================
app.post("/meeting/end", async (req, res) => {
  const { toolCallId, args } = extractArgs(req.body);

  // Accept params from either Vapi args or direct body
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

  // Reset state
  meetingState = { active: false, startTime: null, title: "Untitled Meeting", attendees: [] };

  let markdownSummary = "";
  let spokenSummary = "";
  let saveStatus = "not attempted";

  try {
    // ── Build GPT-4o-mini prompt ──────────────────────────────
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

    // ── Assemble full markdown file ───────────────────────────
    markdownSummary = `# Meeting Notes: ${title}
Date: ${dateET} ET
Attendees: ${attendeeList.join(", ") || "Not specified"}
Duration: ${duration}

${gptOutput}
`;

    // ── Save to OneDrive ──────────────────────────────────────
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

    // ── Build spoken summary (short, for Vapi TTS) ───────────
    // Extract action items from GPT output for spoken summary
    const actionLines = (gptOutput.match(/- \[ \] .+/g) || []).slice(0, 3);
    const actionSpoken = actionLines.length > 0
      ? ` Action items: ${actionLines.map(l => l.replace(/- \[ \] /, "").replace(/ — Owner:.+/, "")).join("; ")}.`
      : "";

    spokenSummary = `Meeting "${title}" wrapped up. Duration was ${duration}.${actionSpoken} Full notes saved to OneDrive under Meeting Notes.`;

  } catch (err) {
    console.error("[meeting/end] GPT error:", err.message);
    // Fallback summary without GPT
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
    spokenSummary = `Meeting "${title}" ended after ${duration}. I saved a basic summary to OneDrive — GPT summarization was unavailable.`;

    // Still try to save fallback
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

// ── Health check ─────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime(), time: nowET(), v: "1.4", meeting_active: meetingState.active }));
app.get("/", (_req, res) => res.json({ ok: true, server: "cammy-vapi-tool-server", v: "1.4" }));

app.listen(PORT, () => console.log(`[${nowET()}] Cammy Vapi Tool Server v1.4 on port ${PORT}`));
