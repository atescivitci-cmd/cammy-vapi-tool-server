// ============================================================
// Pipedream GCAL Proxy Workflow - Step code
// Deploy as: HTTP trigger -> this step
// Connect your Google account (Calendar + Gmail scopes)
// This workflow receives actions from the Render server and
// returns data using the permanent Pipedream OAuth connection.
//
// ENDPOINT: POST https://eoXXX.m.pipedream.net
// Body: { "action": "get_today_schedule"|"get_urgent_emails", "params": {} }
// ============================================================

export default defineComponent({
  props: {
    google: {
      type: "app",
      app: "google",
    },
  },
  async run({ steps, $ }) {
    const body = steps.trigger.event.body || {};
    const action = body.action;
    const params = body.params || {};

    const token = this.google.$auth.oauth_access_token;

    // ── get_today_schedule ──────────────────────────────────
    if (action === "get_today_schedule") {
      const date = params.date || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      const startOfDay = `${date}T00:00:00-04:00`;
      const endOfDay   = `${date}T23:59:59-04:00`;
      const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(startOfDay)}&timeMax=${encodeURIComponent(endOfDay)}&singleEvents=true&orderBy=startTime&maxResults=20`;

      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await resp.json();

      return $.respond({
        status: 200,
        body: { events: data.items || [] }
      });
    }

    // ── get_urgent_emails ───────────────────────────────────
    if (action === "get_urgent_emails") {
      const T1 = ["beth", "izzy", "leo", "atil", "mehmet", "pat", "jack", "scott", "arun", "greg", "tugce", "efruz", "duncan"];
      const T3 = ["hannah", "marko iskander", "alex kokolis", "alex peters", "tanniss", "lex van", "johann eid"];
      const RECRUITER = ["opportunity", "role", "vp", "cro", "chief", "joining", "position", "executive"];
      const SKIP = ["osttra", "ion group", "trireduce", "traiana"];

      const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().split("T")[0];
      const q = encodeURIComponent(`is:unread after:${yesterday}T00:00:00-04:00`);
      const listResp = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=20`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const listData = await listResp.json();
      const messages = listData.messages || [];

      const hits = [];
      for (const msg of messages.slice(0, 15)) {
        const detailResp = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const detail = await detailResp.json();
        const hdrs = detail.payload?.headers || [];
        const from = (hdrs.find(h => h.name === "From")?.value || "").toLowerCase();
        const subject = (hdrs.find(h => h.name === "Subject")?.value || "");
        const subjL = subject.toLowerCase();

        if (SKIP.some(k => from.includes(k) || subjL.includes(k))) continue;

        let tier = null;
        if (T1.some(n => from.includes(n))) tier = "T1";
        else if (T3.some(n => from.includes(n))) tier = "T3";
        else if (RECRUITER.some(k => subjL.includes(k))) tier = "RECRUITER";

        if (tier) {
          const name = from.split("<")[0].trim().split(" ")[0] || from.split("@")[0];
          hits.push({ name, subject, tier });
        }
      }

      return $.respond({
        status: 200,
        body: { hits }
      });
    }

    // ── Unknown action ──────────────────────────────────────
    return $.respond({
      status: 400,
      body: { error: `Unknown action: ${action}` }
    });
  }
});
