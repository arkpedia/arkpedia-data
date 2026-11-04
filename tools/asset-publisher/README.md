# Public R2 publisher

Self-contained copy of the audited Arkpedia public-assets publisher, initially introduced at 99c4f163c38542e933da313852fef67d73e61446 (PR #805) and synchronized with deterministic receipts and incremental Git caching at ecefdefec5a730107208b55be44b568e67f66330 (PR #806). The only source adaptation is the local contract import. Keep both copies synchronized when changing the object/receipt format.

The application repository is private; this job deliberately needs no access to it. Dependency installation receives no credentials. The upload step receives only object read/write credentials scoped to arkpedia-public-assets via the main-only public-assets environment. Git sources are restricted to approved public Arkpedia repositories and immutable commits. No deletion or overwrite is performed.

`native-assets.mjs` and its tests are the native public-view publisher from the
matching Arkpedia commit `d14feee88cf43536d1ea84cc943d67d9d3e7a5c9`, adapted only to local imports.
Keep its source synchronized with `scripts/content/native-assets.mjs`; keep the
contract and original mirror synchronized too. It uses the existing dependency.

Production native delivery is **not activated**. An isolated sample canary passed
in the application change. When `ARKPEDIA_NATIVE_ASSETS_MIRROR=true`, the mirror job also creates immutable, URL-shaped media copies in
`arkpedia-public-assets-direct` before the live-pointer publisher can run. Failure,
including either storage budget being exceeded, blocks the pointer update.
`ARKPEDIA_ASSETS_DELIVERY=native` with mirroring disabled fails explicitly.
An atomic native-bucket lease serializes application/data publishers; per-repository
GitHub concurrency groups alone cannot coordinate them. Its 256-byte public control
object holds only a random owner ID and expiry, never credentials.

Configure the same variables/budgets as the application repository and the
main-only `public-assets` environment secrets `ARKPEDIA_NATIVE_R2_ACCESS_KEY_ID` /
`ARKPEDIA_NATIVE_R2_SECRET_ACCESS_KEY`. The native identity needs source-bucket read
and native-bucket read/write only; keep the original source credentials unchanged.
Do not enable delivery until both publishers, a full historical inventory and an
isolated native-domain canary have passed. Hostname/rule changes are separate
reviewed operations; this repository does not change DNS or serve account data.

Generated `arkpedia-data` snapshots deliberately stay on the deduplicated reader.
Native publication covers all retained media revisions, avoiding repeated copies
of thousands of unchanged JSON records per content release. The canary inventory
measured 47.6 GB across 40 media revisions, about $0.72/month before allowances
and operations; production activation is separate from the approved sample canary.
