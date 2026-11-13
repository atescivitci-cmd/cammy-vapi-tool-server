# Local-phone migration inventory

The current tracked Render source exposes 18 POST endpoints. This inventory
covers every one, including non-/vapi lifecycle endpoints, and is checked
against server.js. It does not alter the server or the uncommitted live patch.

The historical assistant snapshot dated 2026-09-07 contains 30 function schemas;
12 have an explicit Pipedream host in that snapshot. This differs from the
planning report's count of 13. Neither figure proves current workflow parity.
No webhook URLs, tool identifiers, credentials or private payloads are copied.
The separate transfer tool is required by the readiness check.

The known Pipedream source files are a OneDrive upload router in brain-repo and
a calendar/email proxy here. The full assistant workflow source has not been
located. No unrelated brain-repo file is edited in its place. Current assistant
configuration has not been verified with the provider. Both gaps keep the
readiness check false, even if a request asserts confirmed:true.

parity.mjs is an advisory source-readiness check, not a routing controller.
Tool receipt hashes are references to independently reviewed artifacts, not
cryptographic proof of their claims. This inventory does not port the missing
tools or certify provider behavior. Actual tool adapters, current inventory,
spend ceilings and the owner call test remain required before cutover.

Validation: failing-first test module failed before the implementation existed.
`node --test migration/parity.test.mjs`: 4 passed, 0 skipped.
`node call_state.test.mjs`: 14 passed, 0 failed.

No Render/Pipedream deployment, cloud call, live source edit or provider change
was performed. Rollback is to revert this source-only inventory commit.
