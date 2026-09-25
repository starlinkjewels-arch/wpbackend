# Starlink WhatsApp — backend

The API behind the Starlink Jewels WhatsApp web app (see `../WPfrontend`), and
the WhatsApp bridge the AIM billing app already uses. One process, one business
number, linked by QR the same way WhatsApp Web is.

What it does:

- **Clients** — imported from Excel (checked and cleaned in `src/phone.js`),
  added by hand, or **added automatically** when an unknown number messages
  the business (tagged `Inquiry`).
- **Campaigns** — one message, personalised per client (`{{name}}`, any Excel
  column, `{Hi|Hello}` random words), sent **one by one** with a random gap,
  now or at a scheduled time. Sending hours, a daily limit, STOP handling and
  restart-safety are in `src/engine/runner.js`.
- **Inbox** — every reply, auto-reply, opt-out/opt-in.

## Run it on your computer

```
npm install
npm run demo      # pretend WhatsApp + sample clients, nothing is sent. Password: demo
npm start         # the real thing, using .env
npm test          # every rule, no WhatsApp or Firebase needed
```

Then start the web app: `cd ../WPfrontend && npm install && npm run dev` and open
http://localhost:5173.

For testing, `.env` keeps all app data as JSON files in `./data` and uses
Firebase **only** for the WhatsApp login session. `WA_SESSION_ID=local-test`
makes the laptop a separate linked device, so it can never take the live
server's session over (see "When the socket closes" below — two processes on
one session stop messages being delivered).

## Configuration

| Variable | Needed | What it is |
|---|---|---|
| `ADMIN_PASSWORD` | yes | Password for signing in to the web app. Changing it signs everyone out. |
| `API_KEY` | for AIM | Shared secret for server-to-server calls. Must equal the AIM app's `WHATSAPP_SERVICE_API_KEY`. |
| `FRONTEND_ORIGIN` | yes | The web app's address(es), comma-separated, e.g. `https://starlink-wa.vercel.app`. `https://*.vercel.app` allows preview deployments. |
| `DATA_STORE` | no | `local` (default — JSON files in `DATA_DIR`) or `firestore`. **Use `firestore` on Render.** |
| `DATA_DIR` | no | Folder for local data. Default `./data` (`./data-demo` in demo mode). |
| `FIREBASE_SERVICE_ACCOUNT_KEY` | yes* | The service-account JSON on one line. *Or* `FIREBASE_SERVICE_ACCOUNT_PATH` pointing at the file (handy locally). |
| `FIRESTORE_DATABASE_ID` | no | The named database. Default `wpserver`. |
| `WA_SESSION_ID` | no | Which saved WhatsApp session. Default `default`. |
| `DEMO_MODE` | no | `1` for the pretend WhatsApp and sample data. |
| `PORT` | no | Default 3000; hosts set this. |

* The real WhatsApp mode always needs Firebase, for the session. Demo mode and
tests need nothing.

All app collections in Firestore start with `wa` (`waContacts`,
`waCampaigns`, …) and live in their own database, `wpserver`, separate from the
billing app's `starlinkbilling`. The prefix is kept anyway, so pointing
`FIRESTORE_DATABASE_ID` at a shared database can never collide with collections
such as `settings`.

**The service account and the database must belong to the same project.** They
are set independently, so they can drift apart — and when they do, Firestore
answers every read with `5 NOT_FOUND`, because a missing *database* is an error
while a missing *document* is just `exists: false`. That mismatch crash-looped
this service in production. It now reports the mismatch on `/health` instead of
exiting.

## Deploy on Render

1. Put `WPbackend-main` and `WPfrontend` in one Git repository (the
   `render.yaml` beside them points Render at this folder), or push this folder
   alone and set the Root Directory yourself.
2. Render → **New → Blueprint** → choose the repository. Fill in
   `FRONTEND_ORIGIN`, `ADMIN_PASSWORD`, `API_KEY` and
   `FIREBASE_SERVICE_ACCOUNT_KEY` when asked.
3. Open the web app → WhatsApp → scan the QR code with the business phone.

Two things about Render's **free** plan that matter here:

- **It sleeps after 15 minutes without visitors.** Asleep, it cannot start a
  scheduled campaign or receive messages (enquiries are not auto-added while
  asleep). Point a free uptime monitor (UptimeRobot, cron-job.org) at
  `https://<your-service>.onrender.com/health` every 5 minutes, or use a paid
  instance. A campaign that was due while asleep starts as soon as it wakes.
- **Its disk is wiped on every deploy and restart** — which is why
  `DATA_STORE=firestore` there. The WhatsApp session is in Firebase either way,
  so a restart never needs a new QR scan.

Only ever run **one** copy of this service per `WA_SESSION_ID`.

## Web app API (`/api`)

Signed in with `POST /api/auth/login {password}` → `{token}`, then
`Authorization: Bearer <token>` on every call (servers may use `x-api-key`
instead). Errors are `{ error, code }` with the message written for a person.

| Area | Endpoints |
|---|---|
| Status | `GET /api/status` (polled), `GET /api/dashboard`, `POST /api/wa/disconnect` |
| Clients | `GET/POST /api/contacts`, `PUT/DELETE /api/contacts/:id`, `POST /api/contacts/bulk`, `GET /api/contacts/meta`, `GET /api/contacts/export`, `POST /api/contacts/import/preview`, `POST /api/contacts/import/commit` |
| Campaigns | `GET/POST /api/campaigns`, `GET/PUT/DELETE /api/campaigns/:id`, `GET /api/campaigns/:id/recipients`, `POST /api/campaigns/:id/{pause,resume,cancel,retry,duplicate}`, `POST /api/audience/preview`, `POST /api/render`, `POST /api/test-message` |
| Attachments | `POST /api/media` (raw file body, `X-File-Name`), `GET /api/media/:id?sig=…` (signed link) |
| Inbox | `GET /api/conversations`, `GET /api/conversations/:key`, `POST /api/conversations/:key/send` |
| Templates / settings | `/api/templates`, `GET/PUT /api/settings` |

## The WhatsApp bridge

The AIM billing app calls these server-to-server with `x-api-key`. Nothing
here is safe to expose to a browser except `/health`.

### Bridge endpoints (for AIM, `x-api-key`)

| | |
|---|---|
| `GET /health` | No key. `{ ok, status, halted?, error? }` — point an uptime pinger here. |
| `GET /qr` | `{ status: "connected" \| "qr" \| "waiting", qr?, phone?, error? }`. The QR **is a login** to the account: never show it to anyone but the owner. |
| `POST /send` | `{ phone, message?, pdfBase64?, fileName?, clientMessageId? }` |
| `POST /disconnect` | A real WhatsApp logout, and the way to clear a halt. |
| `GET /messages` | Recent inbound, in memory only. |

#### `POST /send`

Returns `{ ok: true, deduped, acknowledged, messageId }`.

- **`acknowledged`** is the honest bit. Baileys resolves a send the moment it
  hands the bytes to its own socket, which is not delivery — reporting that as
  success is why a bill could be marked sent while the recipient saw "Waiting
  for this message". This waits up to 15s for WhatsApp's own server ack.
  `false` means handed over but unconfirmed.
- **`deduped`** means this `clientMessageId` had already been sent and was not
  sent again. Always pass one: the app mints a stable id per bill and reuses it
  on every retry, and without it a retried send is a second invoice for the
  customer.

Failures carry a `code`, and the status says what to do with them:

| Status | `code` | Meaning |
|---|---|---|
| 409 | `NOT_CONNECTED` | Link is down. Nothing was sent — safe to retry. |
| 409 | `IN_FLIGHT` | The same bill is mid-send. Do not send another. |
| 422 | `NOT_ON_WHATSAPP` | The number is not on WhatsApp. No retry will fix it. |
| 400 | `BAD_REQUEST` | Nothing to send. |

## When the socket closes

Not every close means the same thing, and treating them alike is what produced
the two worst symptoms this service has had.

- **440 `connectionReplaced` halts the service.** Something else signed in as
  this number. Reconnecting takes the session back, which kicks the other one,
  which takes it back — both half-alive, and recipients stuck on "Waiting for
  this message". Usually two copies of this service running. Stop the other,
  then `POST /disconnect` or restart.
- **403 halts too.** WhatsApp is refusing the account; that needs the phone.
- **401 / 500 / 411** wipe the saved session so a fresh QR can be scanned.
- **Everything else** keeps the session and dials again, 2s doubling to 60s. A
  dropped connection must never cost the shop a re-scan.

`/health` reports `halted: true` with the reason when the service is waiting
for a person.

## Tests

```
npm test
```

`test/failures.test.js` holds the bridge's rules (close codes, send-once,
setup-page escaping). `test/app.test.js` holds the app's: phone clean-up,
personalisation, sending hours, import review, audiences, a campaign run to
completion, a STOP honoured mid-campaign, pause/resume, no-connection waiting,
the daily cap, auto-add and auto-reply, sign-in tokens, CORS, local files.

`GET /?key=<API_KEY>` is a fallback page for linking a device when the web app
cannot reach the service. A key in a URL ends up in browser history and access
logs — use the web app instead where you can, and rotate `API_KEY` afterwards.
