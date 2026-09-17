# S4H-SOUNDS

An MP3 workspace with the original dark purple/blue visual identity, local WAV encoding and XML metadata exports.

## Run

Requires Python 3.9+; no third-party server dependencies.

```sh
python3 server.py
```

Open http://localhost:8000. The server handles direct navigation and refresh at `/`, `/privacy`, `/app`, and `/app/downloads`. Serve through this server, not a static file server, to enable the counter and route fallback.

## Outputs and state

- WAV: browser-decoded MP3 → real 16-bit PCM WAV, encoded in a Web Worker.
- XML: escaped filename, actual file size, and measured decoded duration/channels/sample rate/sample count. Decoded sample rate is the browser AudioContext rate, not necessarily the source rate. No invented bitrate.
- AAC, FLAC and OGG are visibly disabled until real encoders are implemented.
- Input limit: 50 MB. Decoded limit: 20 minutes / 256 MB PCM. Browsers may still reject files on memory-constrained devices.
- Up to ten recent outputs remain in tab memory within a 128 MB budget (the latest output is always retained), with real blob download links. Refresh closes this session. No audio or download metadata goes to the server.
- Cancel discards output and never submits completion; browser decoding cannot be interrupted, so controls remain locked until it settles.

## Counter design and limits

SQLite contains one row, initialized at zero: `aggregate(id=1, total, downloads)`. Only these two aggregate totals persist. Existing conversion totals migrate in place without resetting. No accounts, IP addresses, filenames, audio, sizes, per-conversion records or identifiers are stored in the database. Access logging is disabled in this server.

`GET /api/count` reads the total. `POST /api/ticket` with `{}` reserves a random token, held only in memory for 30 minutes. After a nonempty output is generated and a download link exists, the client sends `POST /api/complete` with only `{ "token": "…" }`. WAV conversions and XML exports both count. Failed/cancelled conversions never submit completion. Refresh/visits/download clicks never increment. Duplicate submissions of the same token return the count without changing it, including parallel requests. The client retries once with the same token when the response is lost.

Write endpoints require the configured exact Origin, same-origin Fetch Metadata, a custom application header, strict JSON schemas, and a 128-byte maximum body. Tokens are unguessable and single-use. Issuance is capped globally at 60 per minute by default, and at 2,000 live tokens. This avoids IP/device tracking. Limits may cause legitimate completions to be omitted under heavy load; conversion still works. Old tokens are rejected after expiry or a restart, never replayed as fresh completions. Aggregate counts persist across restarts.

**Security boundary:** a server cannot prove that untrusted browser code actually converted audio without receiving the audio or using an independent attestation system. Same-origin controls prevent ordinary cross-site browser calls, but scripts outside browsers can imitate headers and request tokens. This is a bounded, best-effort anonymous completion counter, not fraud-proof accounting. Limits cap abuse; they cannot establish user identity. Tokens contain no audio-derived data. Do not describe this as an authenticated or tamper-proof counter.

Only one server process/instance may issue and consume tokens; SQLite updates are serialized and atomic within that instance. A crash between committing an increment and sending the response does not create a second increment because all pre-restart tokens become invalid. Some offline/unconfirmed completions can be absent; the UI reports this instead of fabricating a value or blocking downloads.

## Hosting

No hosting provider or database was previously configured. This implementation is ready to run on a Python-capable host with a **persistent disk**, behind a production HTTPS reverse proxy; it is not deployed automatically. GitHub Pages alone cannot execute this backend.

```sh
HOST=127.0.0.1 PORT=8000 PUBLIC_ORIGIN=https://your-domain.example \
COUNTER_DB=/persistent/s4h/counter.sqlite3 python3 server.py
```

Run exactly one instance. Preserve the database when deploying. Bind to a private interface behind a hardened reverse proxy (the standard-library HTTP server is not a public production edge). Configure proxy connection limits, body limits and timeouts; disable access/request logging at both proxy and hosting layers to satisfy the no-IP-storage policy. No audio upload endpoint exists. Restrict external access to the Python port. Set `PUBLIC_ORIGIN` to the exact browser-facing origin; arbitrary Host/X-Forwarded headers are not trusted. `COUNTER_TICKETS_PER_MINUTE` changes the overall issuance limit, with no per-user or per-IP state.

A provider migration must preserve the one-row total and move token consumption/rate limits into shared atomic storage before scaling beyond one instance. Do not use ephemeral serverless disks for the persistent total.

## Tests

```sh
python3 -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/conversion.cjs
```

`tests/browser.cjs` uses Playwright and a generated real MP3 fixture (create using the command noted in that file). It exercises routes, privacy/app navigation separation, theme, empty downloads, invalid and corrupt files, WAV/XML output contents, actual downloads, cancellations, duplicate submissions, offline counter behavior and mobile overflow. Run against an isolated test database, never the production counter.

### Validation in this workspace

- Passed 12 Python tests covering persistent aggregate storage, zero initialization, atomic updates, duplicate/parallel requests, expiry, rate limits, strict schemas, origin restrictions and direct routes.
- Passed 8 Node tests covering real WAV encoding, escaped XML, cancellation, failures, repeated clicks, lost acknowledgements and offline counter behavior. Lifecycle tests use an injected decoder; real MP3 decoding was checked separately in the browser.
- In-app browser: tested landing → privacy → home → app, direct route reloads, actual MP3 decoding into WAV/XML, a successful WAV download action, corrupt and invalid inputs, unchanged count after failure/refresh, real recent-download entries, session clearing, theme persistence, and all four routes at 320/375/768/1440 px without horizontal overflow. No browser console errors observed.
- The full standalone Playwright suite is included but could not run in this sandbox: the installed Chrome process was prevented from launching. Safari/Firefox, touch drag-and-drop, and the automated end-to-end download-byte assertions remain unverified here. The encoder's WAV bytes were validated in the Node tests.
- Browser tests used a separate database in `work/`; production starts with an independent empty database.

### Landing-page live statistics

The public landing page reads `/api/stats` immediately and every 15 seconds while visible, plus when the tab becomes visible or reconnects. It displays completed conversions (including XML exports) and download requests. Unavailable data shows a dash and an explicit unavailable status, never a fabricated zero.

A first Download click for a generated output sends `/api/download` with its existing completion token, after completion is acknowledged. The server requires a completed, unexpired token and increments downloads at most once per generated output, even across concurrent/retried requests or the two UI links. Repeat downloads of the same output do not increment. This counts download requests, not confirmed disk saves. Downloads still work when counters are unavailable. Requests after token expiry/restart or an unconfirmed conversion are omitted. Only the aggregate download count is persisted; no filenames, audio, or user details are sent. The same origin restrictions and token issuance limits protect both counters.
