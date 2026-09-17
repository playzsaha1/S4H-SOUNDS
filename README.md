# S4H-SOUNDS

Local MP3-to-WAV conversion and XML metadata export, with anonymous global conversion and download-request totals.

## Vercel deployment

The site uses static browser assets plus five Python Vercel Functions under `api/`. `vercel.json` explicitly builds the four public assets and all five functions, and supplies direct-route rewrites for `/app`, `/app/downloads` and `/privacy`. Local databases, tests, server source and secrets are not published as static files.

**A database connection is required for real global stats.** Pushing the code alone cannot provision storage. SQLite and in-memory tokens are for local development only; they must never back production serverless counters.

1. Open the **s4-h-sounds** project in Vercel → **Storage** → **Create Database**, then choose **Upstash Redis** from the marketplace.
2. Create/select a database and connect it to this project's **Production** environment. Review the provider's plan and terms before confirming.
3. Check that Vercel added the server-only environment variables `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. The adapter also accepts the integration's `KV_REST_API_URL` and `KV_REST_API_TOKEN` names. Use the read/write token, not the read-only token. Do not put credentials in browser code, Git, or chat.
4. Redeploy the latest Git commit. The default allowed origin is `https://s4h-sounds.vercel.app`; set `PUBLIC_ORIGIN` if using a different canonical domain.
5. Open `/api/stats`. A new connected database returns `{"total":0,"downloads":0}`. The landing page then displays real numbers. A missing/unreachable database returns **503**, not an invented zero.

Vercel framework preset is **Other** (`framework: null`). The build rules come from `vercel.json`; clear conflicting project-level Build Command and Output Directory overrides. The function runtime requires no external Python packages. Preview deployments should use a separate database and their own `PUBLIC_ORIGIN` to avoid changing production counts. If migrating an existing live deployment, transfer its verified aggregate totals before switching storage; never seed invented usage.

The function adapter uses Upstash's HTTPS REST API. Only aggregate totals have no expiry. Random per-export deduplication tokens expire after 30 minutes; a global rate-limit key expires after 60 seconds. Lua scripts atomically update tokens and totals together, so simultaneous requests and independent Vercel instances cannot double-count the same event. This temporary anonymous abuse-protection state contains no files, filenames, IPs or device identities.

## Local development

```sh
python3 server.py
```

Open http://localhost:8000. Local mode uses `data/counter.sqlite3` and a single process with in-memory tokens. Local data is ignored by Git and Vercel and never uploaded. Local tokens expire on restart; cloud tokens are shared across instances until their TTL expires.

For a persistent non-Vercel server, set `HOST`, `PORT`, `PUBLIC_ORIGIN`, and `COUNTER_DB` as needed, run one instance, and place the standard-library server behind a production HTTPS reverse proxy. Do not expose the development HTTP server directly to the internet.

## Conversion behavior

- WAV: MP3 decoded by the browser, then genuinely encoded into 16-bit PCM WAV in a worker.
- XML: escaped file details and measured decoded audio properties; metadata, not playable audio. The decoded sample rate is the browser AudioContext rate.
- AAC, FLAC and OGG are disabled and labelled Coming soon.
- Limits: 50 MB MP3; decoded audio up to 20 minutes / 256 MB. Memory-constrained browsers may reject files earlier.
- Up to ten recent outputs remain in tab memory, within a 128 MB budget (the newest output is retained). Refreshing/closing clears the session. Download before leaving.
- Cancellation discards output and never sends a completion. Browser decoding cannot be aborted, so controls remain locked until it settles.

## Counter API and privacy

`GET /api/stats` returns the two global totals. `GET /api/count` provides the legacy conversion total. The public landing polls every 15 seconds while visible and refreshes when revisited or reconnected. Failure is shown explicitly, never masked with zero.

`POST /api/ticket` accepts only `{}` and reserves an unguessable token. `POST /api/complete` accepts only `{ "token": "…" }` after a nonempty output and download link exist. WAV and XML outputs both count. Uploads, visits, refreshes, failures and cancellations do not count. The client retries a lost acknowledgement once using the same token.

The first Download click sends `POST /api/download` with that same token, after completion acknowledgement. At most one download request counts per generated output. Repeated clicks or concurrent retries cannot increment again. Download requests are not proof that a file was saved. Expired tokens, offline completions and failed confirmations may be omitted; local downloads remain usable.

Write endpoints enforce the exact configured Origin, same-origin Fetch Metadata, a custom application header, strict JSON schemas and a 128-byte request-body limit. A shared global issuance limit defaults to 60 tickets per minute (`COUNTER_TICKETS_PER_MINUTE`). No IP-based tracking is used.

The persistent totals contain only conversion and download counts. Temporary anonymous token/limiter keys expire automatically. Audio, filenames, sizes, metadata and user identities are never included in counter requests. Theme preference is saved only in the browser. Application access logging is disabled; hosting/provider logs are separate and must be reviewed/configured by the operator.

**Security boundary:** the server cannot prove a local conversion happened without receiving audio or independent attestation. Non-browser scripts can imitate application headers. This is rate-limited anonymous telemetry, not fraud-proof accounting. Only app-generated outputs trigger counting in the normal workflow.

## Tests

```sh
python3 -m pip install -r requirements-dev.txt
python3 -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/conversion.cjs
```

The tests cover local persistence and migration, atomic Lua scripts with a Redis emulator, independent function instances, duplicate requests, expiry, rate limiting, Vercel configuration/errors, real WAV encoding, escaped XML, cancellation, repeat clicks and counter outages. Without `fakeredis[lua]`, shared-Redis script tests are explicitly skipped.

`tests/browser.cjs` is an additional Playwright suite. Generate its MP3 fixture as documented in the file, and run against an isolated test database. The full standalone suite could not run in the desktop sandbox because Chrome launching was blocked; interactive in-app browser checks verified real WAV/XML exports, download actions, route navigation, theme persistence and mobile overflow. Safari/Firefox and the full automated download-byte assertions remain unverified.
