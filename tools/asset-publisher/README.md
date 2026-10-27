# Public R2 publisher

Self-contained copy of the audited Arkpedia public-assets publisher from arkpedia/arkpedia at 99c4f163c38542e933da313852fef67d73e61446 (PR #805). The only source change is the local contract import. Keep both copies synchronized when changing the object/receipt format.

The application repository is private; this job deliberately needs no access to it. Dependency installation receives no credentials. The upload step receives only object read/write credentials scoped to arkpedia-public-assets via the main-only public-assets environment. Git sources are restricted to approved public Arkpedia repositories and immutable commits. No deletion or overwrite is performed.
