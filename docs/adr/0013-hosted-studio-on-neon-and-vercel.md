# ADR 0013: Hosted Studio on Neon and Vercel

Status: Accepted

## Context

Cozy Studio is local-first: one Bun process, SQLite, a Studio Data Folder and an Output Folder, trusted because it only answers loopback requests. Some owners want to use their Studio from any device and let their own agents generate images through MCP, without keeping a computer awake. Local mode must stay exactly as it is.

## Decision

Hosted Studio is an optional second way to run the same backend. Local mode is unchanged and remains the default.

- **Compute.** The backend runs as a Neon Function (Node 24). `apps/local-server/src/hosted/function.ts` builds the same Hono app through `createStudioApp({ hosted })`. Vercel serves the UI build (`VITE_STUDIO_HOSTED=1`) and rewrites `/api`, `/library`, `/mcp` and `/neon-auth` to the function, so the browser sees one origin.
- **Data.** Stores keep their synchronous `bun:sqlite` API. When `STUDIO_DATABASE_URL` is set, `getDb()` returns a Postgres-backed stand-in: the `pg` driver runs in a worker thread and the caller blocks on `Atomics.wait`. SQLite migrations stay the source of truth; `db/postgres/postgresSchema.ts` mirrors them and a test fails until a new SQLite migration has its Postgres counterpart. Postgres also defines SQLite's JSON and date functions under their SQLite names (`json_valid`, `json_extract`, `json_each`, `json_array_length`, `julianday`), so shared SQL runs on both; what no function can express, such as `COLLATE NOCASE`, branches in `db/sqlDialect.ts`.
- **Files.** Every instance keeps the Studio Data Folder and Output Folder under `/tmp/cozy`, so the absolute paths stored in Postgres resolve the same way everywhere. `libraryMirror.ts` downloads files from Neon Object Storage when they are first read and uploads what changed after requests and jobs. Only files an instance has seen can be deleted remotely. Installed extensions are refreshed from storage by their manifests when Studio lists them, so a style pack installed, updated or removed on one instance reaches the others; the rest of a pack's files download when first read.
- **Jobs.** Persistent Jobs remain the queue truth (ADR 0005). An instance leases a job when it enqueues it, renews the lease while the job is queued or running there, and keeps itself alive with `waitUntil` until its queue drains. A scheduled sweeper adopts jobs whose lease lapsed. Cancelling a job that runs elsewhere marks it in Postgres; the owning instance sees that on its next heartbeat and stops.
- **Events.** `publishEvent` appends to `studio_events`, so revisions are global and durable. Each instance with an open `/api/events` stream polls that table. ADR 0004's reconnect rules still hold.
- **Access.** Loopback trust is replaced by an owner session and agent tokens. The owner signs in with Neon Auth (email code); its JWT is exchanged for an HttpOnly Studio session cookie, accepted only for `STUDIO_OWNER_EMAIL`. Cookie-authenticated writes must come from the Studio origin. Agents use bearer tokens that the owner creates and revokes; only their hash is stored. MCP results carry signed, expiring image links instead of instance paths. The hosted MCP serves the `cozy-studio-mcp` skill as `studio_guide`, bundled into the function, with a `hosted` topic for what differs.
- **Provider Secrets.** Hosted provider sign-in tokens are stored in Postgres only as AES-256-GCM ciphertext; the key (`STUDIO_SECRET_KEY`) lives in the function environment. This is the one deliberate exception to "Provider Secrets never in the database", because a hosted instance has no private app-data folder.
- **Scope.** ChatGPT is the hosted provider. Host-local routes (updates, onboarding, host terminals, Codex app-server, output sources, folder registration, maintenance including duplicate review, local style installs, reset), Library archive export and import, and the sprite atlas and animation workflow modules return 404. An archive can hold more images than an instance keeps on disk.

## Consequences

- Local behaviour and storage do not change; hosted code only runs when `STUDIO_HOSTED=1` or `STUDIO_DATABASE_URL` is set.
- Each Postgres query from a hosted instance blocks its event loop for a few milliseconds. That is acceptable for a single owner and keeps one store implementation.
- New SQLite migrations need a Postgres counterpart in the same change.
- New host-local routes must be added to the hosted route gate.
- An instance's first read of a file downloads it; thumbnails are served without the full image when they already exist.
- ChatGPT sign-in endpoints are not a documented API, and requests now leave a datacenter. Owners import their local sign-in instead of signing in from the server.
