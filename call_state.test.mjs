// PHASE 0.1 verification — prove the two races are actually gone.
//
// The patch footer refers to code/tests/call_state.test.mjs; it was never shipped, so this
// is it. It tests the property that failed in production, not the API surface:
//
//   two concurrent calls must not see or destroy each other's state
//
// Run:  node call_state.test.mjs
import { CallState, SlotConflictError } from "./call_state.mjs";

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log("  PASS  " + name))
                                  : (fail++, console.log("  FAIL  " + name)); };

// Two different Vapi calls, as the server would key them.
const A = CallState.keyFrom({ message: { call: { id: "call-AAA" } } });
const B = CallState.keyFrom({ message: { call: { id: "call-BBB" } } });
ok("distinct calls produce distinct keys", A !== B);

const cs = new CallState();

// ── RACE 1: the meeting singleton ─────────────────────────────────────────────
// Before the patch both writes landed on one module-level object, so Ates's meeting
// was silently replaced by Duncan's and his /meeting/end summarised the wrong one.
cs.put(A, "meeting", { title: "Ates board sync", startTime: 1000, attendees: ["Ates"] });
cs.put(B, "meeting", { title: "Duncan pricing",  startTime: 2000, attendees: ["Duncan"] });

ok("call A keeps its own meeting", cs.get(A, "meeting").title === "Ates board sync");
ok("call B keeps its own meeting", cs.get(B, "meeting").title === "Duncan pricing");
ok("A's start time is not B's",    cs.get(A, "meeting").startTime === 1000);

// Ending one must not end the other.
cs.clear(A, "meeting");
ok("clearing A ends only A",       cs.get(A, "meeting") === null || cs.get(A, "meeting") === undefined);
ok("B's meeting survives A ending", cs.get(B, "meeting")?.title === "Duncan pricing");

// ── H4: nothing to end must be reportable, not fabricated ────────────────────
ok("get on an empty slot is falsy, so the handler can say so",
   !cs.get(CallState.keyFrom({ message: { call: { id: "call-CCC" } } }), "meeting"));

// ── RACE 2: pending bookings ─────────────────────────────────────────────────
// Before the patch a second search overwrote the first pending booking, so a confirm
// could book the wrong restaurant.
cs.put(A, "resy_booking", { venue_name: "Le Bernardin", date: "2026-08-01" });
cs.put(B, "resy_booking", { venue_name: "Carbone",      date: "2026-08-02" });
ok("A confirms Le Bernardin, not Carbone", cs.get(A, "resy_booking").venue_name === "Le Bernardin");
ok("B confirms Carbone",                    cs.get(B, "resy_booking").venue_name === "Carbone");

cs.clear(A, "resy_booking");
ok("B's pending booking survives A confirming", cs.get(B, "resy_booking")?.venue_name === "Carbone");

// ── SAME-CALL UBER ESTIMATE OVERWRITE ────────────────────────────────────────
// Re-estimating in one Vapi call must replace the pending ride, while another
// call's estimate remains isolated.
cs.put(A, "uber_ride", {
  product_id: "uberx",
  fare_id: "fare-airport",
  destination_name: "Airport",
});
cs.put(A, "uber_ride", {
  product_id: "uberxl",
  fare_id: "fare-downtown",
  destination_name: "Downtown",
}, { force: true });
cs.put(B, "uber_ride", {
  product_id: "uberblack",
  fare_id: "fare-suburb",
  destination_name: "Suburbs",
});

const aUber = cs.get(A, "uber_ride");
const bUber = cs.get(B, "uber_ride");
ok("second same-call Uber estimate replaces the first",
   aUber?.product_id === "uberxl" &&
   aUber?.fare_id === "fare-downtown" &&
   aUber?.destination_name === "Downtown");
ok("a same-call Uber overwrite does not affect another call",
   bUber?.product_id === "uberblack" &&
   bUber?.fare_id === "fare-suburb" &&
   bUber?.destination_name === "Suburbs");

// ── slot isolation within one call ───────────────────────────────────────────
ok("a meeting and a booking coexist on one call",
   !!cs.get(B, "meeting") && !!cs.get(B, "resy_booking"));

// ── stats replaces the bare meeting_active boolean on /health ────────────────
const st = cs.stats();
ok("stats() returns an object for /health", st && typeof st === "object");

console.log("\n  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
