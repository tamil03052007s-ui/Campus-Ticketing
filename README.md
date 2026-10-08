# Campus Passes

Event ticketing and door check-in for campus events. Set up for **VIT** out of the box: the home page reads "Upcoming at VIT", tickets are issued per college email domain, and organizers can add events from the portal.

Students browse events and register. They get an HTML email with a **cryptographically signed QR ticket**. Organizers scan that QR code with a webcam (or paste the ticket code) in a separate portal, and the server decides in real time whether the ticket is valid, already used, or counterfeit.

| Requirement | Where it lives |
| --- | --- |
| Registration portal with capacity limits | `public/index.html`, `public/register.html`, `POST /api/events/:id/register` (rejects with `SOLD_OUT` at capacity) |
| Transactional email with embedded signed QR | `src/mailer.js` (Nodemailer over SMTP: Resend, SendGrid, Brevo, Gmail, anything SMTP), `src/tokens.js` |
| Organizer scan portal with webcam scanner and manual fallback | `public/organizer.html`, `public/js/organizer.js` (uses [jsQR](https://github.com/cozmo/jsQR)) |
| CHECKED-IN / ALREADY USED / INVALID TICKET | `POST /api/organizer/verify` in `src/app.js` |

**Stack:** Node.js 22.13+ (developed and tested on Node 22), Express 5, SQLite through Node's built-in `node:sqlite` (nothing native to compile), Nodemailer, vanilla JS front end (no build step).

---

## Quick start

```bash
git clone <your-repo-url> campus-passes
cd campus-passes
npm install
npm start
```

You need Node.js **22.13 or newer** (`node -v`). There are no native modules, so `npm install` needs no compiler. `npm start` and `npm test` silence Node's one-line "SQLite is experimental" notice; if you run `node src/server.js` directly you'll see it, and it is harmless.

Open <http://localhost:3000>. That's it: **no credentials are needed to try it.** With no SMTP settings, ticket emails are written to `./outbox/` and listed at <http://localhost:3000/dev/outbox>, so you can open the exact HTML email in a browser. The database is created on first run and filled from `events.json` (five sample events, one of them only 5 seats so you can test the sold-out state).

For development defaults, the organizer passcode is `organizer-demo` and a signing secret is generated into `./data/.dev-signing-secret`. Both print a warning at startup. **Set your own before deploying** (see below).

To send real email, copy `.env.example` to `.env` and fill in the SMTP section.

---

## Environment variables

Put these in a `.env` file (loaded automatically) or set them in your host's dashboard. `.env.example` is a ready-to-copy template.

### Required in production

| Variable | Description |
| --- | --- |
| `TICKET_SIGNING_SECRET` | Secret that signs every ticket QR code (at least 32 characters). Anyone who knows it can forge tickets. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Changing it invalidates all tickets already emailed. |
| `ORGANIZER_PASSCODE` | Passcode organizers type to open the scan portal. |
| `NODE_ENV` | Set to `production`. This makes the two values above mandatory and turns off the `/dev/outbox` pages. |

### Email provider (third-party mailer credentials)

Delivery uses **SMTP through Nodemailer**, so any provider works. Leave `SMTP_HOST` empty to use the local outbox instead.

| Variable | Description |
| --- | --- |
| `SMTP_HOST` | SMTP server hostname, for example `smtp.resend.com`. |
| `SMTP_PORT` | Defaults to `587`. |
| `SMTP_SECURE` | `true` for implicit TLS (port 465). Defaults to `true` when `SMTP_PORT=465`, otherwise `false` (STARTTLS is used when the server offers it). |
| `SMTP_USER` | SMTP username. |
| `SMTP_PASS` | SMTP password or API key. |
| `MAIL_FROM` | The From address, for example `Campus Passes <tickets@yourdomain.edu>`. **Required when `SMTP_HOST` is set**, and it must be a sender or domain your provider has verified, or the provider will reject the message. |

Typical settings per provider (confirm against your provider's dashboard, since account setups differ):

| Provider | `SMTP_HOST` | `SMTP_PORT` | `SMTP_USER` | `SMTP_PASS` |
| --- | --- | --- | --- | --- |
| [Resend](https://resend.com) | `smtp.resend.com` | `465` (or `587`) | `resend` | your API key (`re_...`) |
| [SendGrid](https://sendgrid.com) | `smtp.sendgrid.net` | `587` | `apikey` | your API key (`SG....`) |
| [Brevo](https://brevo.com) | `smtp-relay.brevo.com` | `587` | your SMTP login | your SMTP key (not your account password) |
| Gmail (testing only) | `smtp.gmail.com` | `465` | your address | an [app password](https://myaccount.google.com/apppasswords) |

Example `.env` for Resend:

```ini
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_USER=resend
SMTP_PASS=re_your_api_key
MAIL_FROM=Campus Passes <tickets@your-verified-domain.edu>
```

**Check your credentials before the first registration:**

```bash
npm run mail:test -- you@example.com
```

This logs in to the SMTP server and sends a sample ticket email to the address you give. (The sample ticket has no registration behind it, so scanning it reports INVALID TICKET.) The server also verifies the SMTP login at startup and prints the result.

### College settings (VIT)

| Variable | Description |
| --- | --- |
| `ORG_NAME` | Name shown on the home page and in the ticket email, e.g. `VIT` gives "Upcoming at VIT". Leave empty for neutral wording. |
| `ALLOWED_EMAIL_DOMAINS` | Comma-separated domains allowed to register; subdomains are accepted too. VIT Vellore and Chennai students use `vitstudent.ac.in` and staff use `vit.ac.in`, so `vitstudent.ac.in,vit.ac.in` is the usual value. **Check your own campus's domain** (VIT Bhopal and VIT-AP use different ones). Leave empty while testing. |
| `EVENTS_FILE` | JSON file used to fill a brand-new database. Default `./events.json`. |

Events are managed two ways:

1. **From the organizer portal.** Sign in and use **Manage events** at the bottom: name, venue, description, start time and seats. New events appear on the public page immediately. An event that already has registrations cannot be deleted.
2. **Through `events.json`.** Edit it before the first run (or before a fresh deploy). Each entry needs `title`, `venue` and `capacity`, plus either `startsAt` (an ISO time) or `inDays` with `timeIST` (e.g. `"17:00"`). The file is only read when the database is empty, so changing it later does not touch an existing database.

### Optional

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. |
| `EVENT_TIMEZONE` | `Asia/Kolkata` | Time zone for the event time printed inside the email. Web pages show each visitor's local time. |
| `TRUST_PROXY` | *(off)* | Set to `1` behind a single reverse proxy so rate limits see real client IPs. |
| `DB_PATH` | `./data/tickets.db` | SQLite file. Point it at a persistent disk when deploying. |
| `OUTBOX_DIR` | `./outbox` | Where dev-mode emails are saved. |

---

## Testing the organizer scan workflow locally

Start the app (`npm start`) with no SMTP settings, then follow either path. Both end at the same verification endpoint.

### 1. Register a test ticket

1. Open <http://localhost:3000>, choose an event, and register with any name and email.
2. On the confirmation screen, click **Open the email** (or browse to <http://localhost:3000/dev/outbox>). You'll see the exact email a student would get, with the QR code and, underneath it, the plain-text **ticket code** (it starts with `CT1.`).

### 2a. Scan without a camera (paste the code)

1. Open <http://localhost:3000/organizer.html> and sign in (`organizer-demo` unless you set `ORGANIZER_PASSCODE`).
2. Paste the ticket code into **Enter a ticket code** and press **Verify**.

### 2b. Scan with the webcam

1. Keep the email open on a **second device** (a phone works well) or in a separate window.
2. On the organizer page, press **Start camera** and allow camera access. Hold the QR code in front of the webcam. The page scans continuously and reacts as soon as it reads the code, with a colour flood, a sound and a vibration on phones.

Camera access only works on `http://localhost` or over HTTPS. To scan from a phone against the app running on your laptop, serve the app over HTTPS (for example with a tunnelling tool) rather than a plain `http://192.168.x.x` address, or the browser will refuse to open the camera. If the camera is unavailable, the page says why and the paste field still works.

### 3. What you should see

| Action | Result shown |
| --- | --- |
| Scan a valid ticket for the first time | Green **CHECKED-IN** with the attendee's name and the check-in time |
| Scan the same ticket again | Amber **ALREADY USED** with the **original** check-in timestamp |
| Change one character of the ticket code and verify | Red **INVALID TICKET** (signature check fails) |
| Paste random text or a URL | Red **INVALID TICKET** |
| Pick one event in **Event being scanned**, then scan a ticket for a different event | Grey **WRONG EVENT** (the ticket is **not** used up) |
| Network or server problem | Dark **NOT VERIFIED** (nothing was checked in; scan again) |

A QR code held steadily in front of the camera counts as one scan. It is only scanned again after it has left the frame for a couple of seconds, so a lingering ticket doesn't flip to ALREADY USED by itself. The counters and **Recent scans** list update after every scan and every three seconds, so a second scanner at another door shows up too.

### 4. Test the capacity limit

**Alumni Fireside Chat** is seeded with only 5 seats. Register five different email addresses, then try a sixth: the form is replaced with "This event is full", the card on the home page shows **Sold out**, and the API answers `409 SOLD_OUT`.

### 5. Test email failure handling

Set `SMTP_HOST` to something unreachable, or use a wrong `SMTP_PASS`, and register. You get a clear error and **no seat is held**, so a student never has a ticket they didn't receive.

---

## How it works

**Signed tickets.** Registration creates a ticket row with a random UUID. The QR code encodes a token:

```
CT1.<eventId>.<ticketId>.<signature>
signature = base64url( HMAC-SHA256( key, "CT1.<eventId>.<ticketId>" ) )
```

The key is derived from `TICKET_SIGNING_SECRET`. Tokens are never stored: the server re-derives the signature on every scan and compares it in constant time. Without the secret nobody can mint a token that passes, and altering any character invalidates it. A token with a valid signature is still checked against the database, so it must match a real registration.

**Check-in is atomic.** The first valid scan runs `UPDATE tickets SET checked_in_at = ? WHERE id = ? AND checked_in_at IS NULL`. Only one request can change the row, so if two scanners read the same ticket at the same instant, exactly one gets CHECKED-IN and the rest get ALREADY USED with the first timestamp. This is covered by a test that fires eight simultaneous scans.

**Capacity is race-free.** The seat count and the insert happen in one write transaction, so two students competing for the last seat can't both get it. A test fires 12 parallel registrations at a 4-seat event and expects exactly 4 successes. One ticket per email address per event.

**Audit trail.** Every scan attempt, including counterfeit ones, is recorded in the `scan_log` table (result and reason only, never the raw token).

**Security measures.** Organizer endpoints need a signed, 12-hour session token from the passcode login. Login, registration, resend and scan endpoints are rate limited. Responses carry a Content-Security-Policy, and the front end builds all DOM with `textContent`, so event and attendee names can't inject markup. Inputs are validated and email addresses are normalized to lower case. The "send my ticket again" endpoint answers the same way for registered and unregistered addresses.

---

## API

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/events` | none | List events with `capacity`, `registered`, `remaining`, `soldOut` |
| `GET /api/events/:id` | none | One event |
| `GET /healthz` | none | Health check, returns `{ "ok": true }` |
| `POST /api/events/:id/register` | none | Body `{ name, email }`. `201` on success; `409 SOLD_OUT` or `ALREADY_REGISTERED`; `502 EMAIL_FAILED` |
| `POST /api/events/:id/resend` | none | Body `{ email }`. Re-sends an unused ticket; always `202` |
| `POST /api/organizer/login` | none | Body `{ passcode }`. Returns a bearer `token` |
| `GET /api/organizer/events` | organizer | Events with check-in counts |
| `POST /api/organizer/events` | organizer | Body `{ title, venue, description?, startsAt, capacity }`. `201` with the new event |
| `DELETE /api/organizer/events/:id` | organizer | `409 EVENT_HAS_TICKETS` if anyone has registered |
| `GET /api/organizer/summary?eventId=` | organizer | Live counts and recent scans |
| `POST /api/organizer/verify` | organizer | Body `{ token, eventId? }`. Returns `status` (`CHECKED_IN`, `ALREADY_USED`, `INVALID`, `WRONG_EVENT`), `label`, `attendee`, `event`, `checkedInAt` |

Verification outcomes return HTTP `200` with a `status` field. `401` means the organizer session is missing or expired.

Quick check from a terminal:

```bash
TOKEN=$(curl -s localhost:3000/api/organizer/login -H 'Content-Type: application/json' \
  -d '{"passcode":"organizer-demo"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s localhost:3000/api/organizer/verify -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"token":"CT1.1.paste-a-ticket-code-here"}'
```

---

## Project layout

```
src/
  server.js     starts the app, verifies SMTP at boot
  app.js        routes, capacity transaction, check-in logic, security headers
  tokens.js     HMAC-signed ticket tokens
  mailer.js     HTML email builder, SMTP delivery, dev outbox
  db.js         SQLite schema, transaction helper, events.json seeding
  config.js     environment variable parsing and validation
public/
  index.html, register.html, organizer.html
  css/app.css, js/*.js, favicon.svg
  fonts/        self-hosted variable font (OFL licence included)
events.json     events loaded into a new database
render.yaml     one-click deploy blueprint for Render
.node-version   Node version for hosts that read it
scripts/send-test-email.js   `npm run mail:test`
test/                        `npm test`
```

## Automated tests

```bash
npm test
```

20 tests run against a real server and database: capacity limits (including parallel registration), duplicate and invalid input, first scan / second scan / simultaneous scans, tampered and forged tokens, wrong-event scans, organizer auth, email-failure rollback, event creation and deletion, the VIT domain restriction, `events.json` seeding, cache and compression headers, and a full SMTP round trip against an in-process SMTP server that checks the login, the From address, the inline `cid:` QR image and that the QR in the email decodes back to the ticket token.

## Deploying as a live website

The app is one Node process with one SQLite file, so it needs a host that offers a **persistent disk** and **HTTPS** (phones refuse to open the camera on plain HTTP).

### Render (uses `render.yaml`)

1. Push this project to a public GitHub repository.
2. On [render.com](https://render.com) choose **New, Blueprint** and pick the repository. Render reads `render.yaml`.
3. Fill in the values it asks for: `ORGANIZER_PASSCODE`, `ALLOWED_EMAIL_DOMAINS`, and the SMTP settings (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`). `TICKET_SIGNING_SECRET` is generated for you.
4. Deploy, then open the URL Render gives you. `/healthz` should answer `{"ok":true}`.
5. Sign in at `/organizer.html`, check the events, and register one real ticket to confirm the email arrives.

Notes: the blueprint uses the paid `starter` plan because disks are not available on the free plan. On the free plan you can still demo the site, but registrations are lost whenever the instance restarts, which breaks tickets already emailed (events are re-created from `events.json`). `render.yaml` has not been run against a live Render account by the author, so read the dashboard prompts carefully on first deploy.

### Any other host (VPS, Railway, Fly.io)

Set `NODE_ENV=production`, `TICKET_SIGNING_SECRET`, `ORGANIZER_PASSCODE`, the SMTP variables, point `DB_PATH` at a persistent volume, set `TRUST_PROXY=1` behind a proxy, run `npm ci && npm start`, and run a single instance.

### Performance

- Responses are gzip-compressed. Measured on the local server: home page 1.4 KB (0.6 KB compressed), `app.css` 15 KB (3.9 KB), `organizer.js` 12 KB (4.2 KB), jsQR 257 KB (53 KB, loaded only when the camera starts).
- The font is self-hosted (67 KB, subsetted to Latin, cached for a year, preloaded). No third-party requests are made, which also keeps the strict Content-Security-Policy.
- HTML, CSS and JS use ETags so repeat visits get a `304`. SQLite runs in WAL mode.

## Not included

- VIT logos and branding. The product is called Campus Passes and only the name "VIT" is shown; add official branding only with your college's permission.
- Payments, ticket transfers and refunds are out of scope.
- Live updates use a three-second poll rather than WebSockets.
