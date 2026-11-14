# Public R2 publisher

Self-contained copy of the audited Arkpedia public-assets publisher, initially introduced at 99c4f163c38542e933da313852fef67d73e61446 (PR #805) and synchronized with deterministic receipts and incremental Git caching at ecefdefec5a730107208b55be44b568e67f66330 (PR #806). The only source adaptation is the local contract import. Keep both copies synchronized when changing the object/receipt format.

The application repository is private; this job deliberately needs no access to it. Dependency installation receives no credentials. The upload step receives only object read/write credentials scoped to arkpedia-public-assets via the main-only public-assets environment. Git sources are restricted to approved public Arkpedia repositories and immutable commits. No deletion or overwrite is performed.

`native-assets.mjs` and its tests are the native public-view publisher from the
matching Arkpedia commit `a91e58c7a4dd52ec65ab40aafa2925cc964c31c9`, adapted only to local imports.
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
`ARKPEDIA_NATIVE_R2_SECRET_ACCESS_KEY`. The new native identity needs native-bucket object read/write only. The original
source identity remains unchanged and its native-publication adapter refuses writes.
The current workflow preserves this tooling before checking out historical content,
including rollback releases predating the native publisher.
Do not enable delivery until both publishers, a full historical inventory and an
isolated native-domain canary have passed. Hostname/rule changes are separate
reviewed operations; this repository does not change DNS or serve account data.

Generated `arkpedia-data` snapshots deliberately stay on the deduplicated reader.
Native publication covers all retained media revisions, avoiding repeated copies
of thousands of unchanged JSON records per content release. The canary inventory
measured 47.6 GB across 40 media revisions, about $0.72/month before allowances
and operations; production activation is separate from the approved sample canary.

The selected steady state is now **one unified bucket**, not a permanent old
mirror dependency. `ARKPEDIA_UNIFIED_ASSETS=true` selects `unified-assets.mjs`: it
reads approved GitHub commits, writes media directly at native URL paths, and
keeps generated JSON deduplicated in the same new bucket. Media dependencies finish
before JSON readiness/live-pointer adoption. This step receives only the native
credential and skips both legacy mirror stages. Existing completed revisions do
not need a Git fetch or old-bucket reads. Activate both publishers only after
the historical media/JSON migrations and new-bucket reader checks pass.

Unified publication and the shared Git metadata/source helpers match the same application commit. The public copy changes only relative imports; keep all three publisher modules and their tests synchronized.

### Native reuse compatibility

The optional `ARKPEDIA_NATIVE_MEDIA_REUSE=true` mode uses matching immutable
readiness directory hashes to reuse completed native media groups. Model bundles
remain atomic and stored bytes are unchanged. New receipts carry sparse `native`
maps; data readiness carries bounded `media` maps for its dependencies. Git JSON
and historical URLs remain unchanged. `media-reuse.mjs`, `mediaDelivery.mjs` and
`media-reuse.test.mjs` are vendored from the app with local imports only.

Deploy the app consumer with `nativeMediaDelivery: 1` first; publication refuses
reuse without that clean production capability. Enable the same flag in both
repositories after verification. Keep the existing per-run/total byte budgets,
lease, new-bucket-only destination and readiness-before-pointer ordering. Disabling
the flag does not undo published maps: older app rollback requires restoring and
verifying an unmapped historical content release first. No deletion is performed.

## Event media before a site Preview

The existing Content release owner accepts an optional `animation_revision`: a
full immutable `arkpedia-l2d-assets` commit. This uses the same unified publisher,
bucket-scoped credential, native lease, storage budgets and verified receipts.
An asset-only dispatch skips the live-pointer job. It does not regenerate records
or promote the selected data snapshot. Normal push releases and rollbacks are
unchanged when the input is blank.

Use the current live data revision as `revision` and the reviewed asset commit as
`animation_revision` when dispatching `content.yml` on `main`. The pin helper is
preserved before selecting that older data checkout, as the publisher itself is.
Verify the new animation files over the CDN before the site adopts their URLs.

Asset-only event dispatches enable the existing verified native-media reuse mode.
The L2D repository also contains the full model archive; unchanged directory
hashes reuse completed immutable media instead of copying that archive for every
new event pack. The publisher still refuses reuse unless clean production reports
`nativeMediaDelivery: 1`, and still applies its lease, byte budgets and create-only
verification. Normal content releases continue using the repository flag.
