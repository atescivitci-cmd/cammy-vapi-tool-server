// PHASE 0.1 — immediate patch for the two reproduced races.
//
// The live cammy-vapi-tool-server holds:
//   let meetingState = {...}                  // one global object
//   app.locals.pendingResyBooking = {...}     // one global slot
//   app.locals.pendingUberRide    = {...}     // one global slot
//
// Reproduced consequences:
//   - Start a second meeting and the first is silently destroyed. It can never be
//     ended and its notes are unrecoverable.
//   - Two concurrent orders cross-wire: ordered Logan Airport and Providence,
//     then confirmed -> "on the way to Providence."
//
// This module replaces all three with keyed, TTL-swept state. Drop-in for Node 18+,
// no dependencies. It is the stopgap until core/continuum.py owns this properly.
//
// H3 collision check before dropping in:
//   grep -n "CallState\|call_state" server.js    # expect zero hits

const DEFAULT_TTL_MS = {
  meeting: null,               // meetings do not expire on a timer
  resy_booking: 5 * 60 * 1000,
  uber_ride: 3 * 60 * 1000,
};

export class SlotConflictError extends Error {
  constructor(kind, ageMs) {
    super(`${kind} already active (${Math.round(ageMs / 1000)}s old)`);
    this.name = "SlotConflictError";
    this.kind = kind;
    this.ageMs = ageMs;
  }
}

export class CallState {
  constructor({ sweepMs = 60_000 } = {}) {
    /** @type {Map<string, Map<string, {data:any, created:number, ttl:number|null}>>} */
    this._byCall = new Map();
    this._timer = setInterval(() => this.sweep(), sweepMs);
    if (this._timer.unref) this._timer.unref();   // never hold the process open
  }

  // Vapi gives a stable call id; fall back to the tool call id, then a per-request
  // id. The fallback still isolates concurrent callers, which is the whole point.
  static keyFrom(body) {
    return (
      body?.message?.call?.id ||
      body?.call_id ||
      body?.message?.toolCallList?.[0]?.id ||
      `anon_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    );
  }

  /**
   * Store state for this call. Throws SlotConflictError rather than clobbering.
   *
   * Refusing is the correct behavior: the caller can then say something true
   * ("you already have a meeting running, close that one first?") instead of
   * destroying the first meeting without a word.
   */
  put(callKey, kind, data, { ttlMs, force = false } = {}) {
    const slots = this._byCall.get(callKey) ?? new Map();
    const existing = slots.get(kind);
    if (existing && !force && !this._expired(existing)) {
      throw new SlotConflictError(kind, Date.now() - existing.created);
    }
    slots.set(kind, {
      data,
      created: Date.now(),
      ttl: ttlMs !== undefined ? ttlMs : (DEFAULT_TTL_MS[kind] ?? null),
    });
    this._byCall.set(callKey, slots);
    return data;
  }

  get(callKey, kind) {
    const slot = this._byCall.get(callKey)?.get(kind);
    if (!slot) return null;
    if (this._expired(slot)) {
      this._byCall.get(callKey).delete(kind);
      return null;
    }
    return slot.data;
  }

  /** Age in ms, or null if absent — lets a caller say "that was 4 minutes ago". */
  ageOf(callKey, kind) {
    const slot = this._byCall.get(callKey)?.get(kind);
    return slot && !this._expired(slot) ? Date.now() - slot.created : null;
  }

  clear(callKey, kind) {
    const slots = this._byCall.get(callKey);
    if (!slots) return false;
    const had = slots.delete(kind);
    if (slots.size === 0) this._byCall.delete(callKey);
    return had;
  }

  clearCall(callKey) {
    return this._byCall.delete(callKey);
  }

  sweep() {
    let dropped = 0;
    for (const [key, slots] of this._byCall) {
      for (const [kind, slot] of slots) {
        if (this._expired(slot)) { slots.delete(kind); dropped++; }
      }
      if (slots.size === 0) this._byCall.delete(key);
    }
    return dropped;
  }

  _expired(slot) {
    return slot.ttl !== null && Date.now() - slot.created > slot.ttl;
  }

  /** Surfaces in /health so an orphaned meeting is visible instead of invisible. */
  stats() {
    const kinds = {};
    let open = 0;
    for (const slots of this._byCall.values()) {
      for (const [kind, slot] of slots) {
        if (this._expired(slot)) continue;
        kinds[kind] = (kinds[kind] || 0) + 1;
        open++;
      }
    }
    return { active_calls: this._byCall.size, open_slots: open, by_kind: kinds };
  }

  stop() { clearInterval(this._timer); }
}

/*
  ── Wiring (done — this is a record, not a TODO) ────────────────────────────

  TRACKER_42_V1 (2026-08-23): this block used to read as forward-looking
  patch instructions ("replace `meetingState = {...}` with...", "in the
  confirm handlers..."). All four edits it described landed in server.js
  under "Phase 0.1: per-call state — kill two live data-loss races" (#2,
  commit d0a0339) and are still in place — grep server.js for "PHASE 0.1" to
  see all of them: the callState import/instantiation near the top, the
  meeting start/end put/get/clear, the resy_booking put/get/clear, and the
  /health `state: callState.stats()` line. It also pointed at
  `code/tests/call_state.test.mjs`, a path that never existed in this repo's
  history — the test lives at the repo root, `call_state.test.mjs`.
  Left here as a historical note of what shipped and why, not as something
  still to be done.

  1) Near the top of server.js:

       import { CallState, SlotConflictError } from "./call_state.mjs";
       const callState = new CallState();

  2) /meeting/start:

       const callKey = CallState.keyFrom(req.body);
       try {
         callState.put(callKey, "meeting", {
           startTime: Date.now(), title, attendees: Array.isArray(attendees) ? attendees : [attendees],
         });
       } catch (e) {
         if (e instanceof SlotConflictError) {
           const mins = Math.round(e.ageMs / 60000);
           return vapiRespond(res,
             `You already have a meeting running, started ${mins} minute${mins === 1 ? "" : "s"} ago. ` +
             `Want me to wrap that one up first?`, toolCallId);
         }
         throw e;
       }

     /meeting/end — read it, and say so honestly when there is nothing to end:

       const callKey = CallState.keyFrom(req.body);
       const meeting = callState.get(callKey, "meeting");
       if (!meeting) {
         return vapiRespond(res, "I do not have a meeting running to wrap up.", toolCallId);
       }
       const startTime = meeting.startTime;
       // ...build the summary...
       callState.clear(callKey, "meeting");

  3) Bookings and rides — replaced the app.locals singletons:

       // in book_resy / order_uber
       callState.put(CallState.keyFrom(req.body), "resy_booking", {...});

       // in the confirm handlers
       const pending = callState.get(CallState.keyFrom(req.body), "resy_booking");
       if (!pending) {
         return vapiRespond(res,
           "That booking request expired. Want me to search again?", toolCallId);
       }
       // ...on success...
       callState.clear(CallState.keyFrom(req.body), "resy_booking");

  4) /health — replaced the bare `meeting_active` boolean:

       app.get("/health", (_req, res) => res.json({
         ok: true, uptime: process.uptime(), time: nowET(), v: V_SHORT,
         state: callState.stats(),      // instead of meeting_active
         tools: [...],
       }));

  ── Verify ──────────────────────────────────────────────────────────────────
    node --check server.js
    node call_state.test.mjs

  ── Rollback ────────────────────────────────────────────────────────────────
    git revert the wiring commit (d0a0339). This file is additive; deleting it
    and the four edits above restores the previous behavior exactly.
*/
