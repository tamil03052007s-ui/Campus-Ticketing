'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const { createTokenService } = require('./tokens');
const { transaction } = require('./db');

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const EVENT_SELECT = `
  SELECT e.id, e.title, e.description, e.venue, e.starts_at AS startsAt, e.capacity,
    (SELECT COUNT(*) FROM tickets t WHERE t.event_id = e.id) AS registered,
    (SELECT COUNT(*) FROM tickets t WHERE t.event_id = e.id AND t.checked_in_at IS NOT NULL) AS checkedIn
  FROM events e`;

const STATUS_LABELS = {
  CHECKED_IN: 'CHECKED-IN',
  ALREADY_USED: 'ALREADY USED',
  INVALID: 'INVALID TICKET',
  WRONG_EVENT: 'WRONG EVENT',
};

const SESSION_HOURS = 12;

function cleanName(value) {
  if (typeof value !== 'string') return null;
  const name = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return name.length >= 2 && name.length <= 80 ? name : null;
}

function cleanEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254) return null;
  return /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[^\s@<>()",;:\\]{2,}$/.test(email) ? email : null;
}

function cleanText(value, { min, max, multiline = false }) {
  if (typeof value !== 'string') return null;
  let text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  text = multiline
    ? text.replace(/[ \t]+/g, ' ').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    : text.replace(/\s+/g, ' ').trim();
  return text.length >= min && text.length <= max ? text : null;
}

/** Validates the organizer's "create event" form. Throws a 400 HttpError naming the first bad field. */
function parseEventInput(body) {
  const title = cleanText(body?.title, { min: 3, max: 120 });
  if (!title) throw new HttpError(400, 'INVALID_TITLE', 'Enter an event name (3 to 120 characters).');
  const venue = cleanText(body?.venue, { min: 2, max: 120 });
  if (!venue) throw new HttpError(400, 'INVALID_VENUE', 'Enter a venue (2 to 120 characters).');
  const rawDescription = body?.description === undefined || body.description === null ? '' : body.description;
  const description = cleanText(rawDescription, { min: 0, max: 600, multiline: true });
  if (description === null) throw new HttpError(400, 'INVALID_DESCRIPTION', 'Keep the description under 600 characters.');

  const when = typeof body?.startsAt === 'string' ? new Date(body.startsAt) : null;
  if (!when || Number.isNaN(when.getTime())) throw new HttpError(400, 'INVALID_TIME', 'Pick a start date and time.');
  if (when.getTime() < Date.now() - 3_600_000) throw new HttpError(400, 'INVALID_TIME', 'Pick a start time in the future.');
  if (when.getTime() > Date.now() + 3 * 365 * 86_400_000) throw new HttpError(400, 'INVALID_TIME', 'That start time is too far ahead.');

  const rawSeats = typeof body?.capacity === 'string' && /^\d{1,6}$/.test(body.capacity) ? Number(body.capacity) : body?.capacity;
  if (!Number.isInteger(rawSeats) || rawSeats < 1 || rawSeats > 10_000) {
    throw new HttpError(400, 'INVALID_CAPACITY', 'Seats must be a whole number from 1 to 10,000.');
  }
  return { title, venue, description, startsAt: when.toISOString(), capacity: rawSeats };
}

function parseId(value) {
  if (!/^[1-9]\d{0,9}$/.test(String(value))) throw new HttpError(404, 'EVENT_NOT_FOUND', 'That event doesn’t exist.');
  return Number(value);
}

function createApp({ config, db, mailer }) {
  const tokens = createTokenService(config.ticketSecret);
  const sessionKey = crypto.createHmac('sha256', config.ticketSecret).update('organizer-session-v1').digest();
  const passcodeDigest = sha256(config.organizerPasscode);
  const hmac = (payload) => crypto.createHmac('sha256', sessionKey).update(payload).digest('base64url');

  const stmt = {
    listEvents: db.prepare(`${EVENT_SELECT} ORDER BY e.starts_at ASC, e.id ASC`),
    getEvent: db.prepare(`${EVENT_SELECT} WHERE e.id = ?`),
    insertEvent: db.prepare('INSERT INTO events (title, description, venue, starts_at, capacity) VALUES (?, ?, ?, ?, ?)'),
    deleteEvent: db.prepare('DELETE FROM events WHERE id = ?'),
    findTicket: db.prepare('SELECT * FROM tickets WHERE event_id = ? AND email = ?'),
    getTicket: db.prepare('SELECT * FROM tickets WHERE id = ?'),
    insertTicket: db.prepare('INSERT INTO tickets (id, event_id, name, email) VALUES (?, ?, ?, ?)'),
    deleteTicket: db.prepare('DELETE FROM tickets WHERE id = ? AND checked_in_at IS NULL'),
    checkIn: db.prepare('UPDATE tickets SET checked_in_at = ? WHERE id = ? AND checked_in_at IS NULL'),
    logScan: db.prepare('INSERT INTO scan_log (event_id, ticket_id, result, detail) VALUES (?, ?, ?, ?)'),
    recentAll: db.prepare(`
      SELECT s.result, s.scanned_at AS at, t.name AS attendee, e.title AS eventTitle
      FROM scan_log s LEFT JOIN tickets t ON t.id = s.ticket_id LEFT JOIN events e ON e.id = COALESCE(t.event_id, s.event_id)
      ORDER BY s.id DESC LIMIT 12`),
    recentForEvent: db.prepare(`
      SELECT s.result, s.scanned_at AS at, t.name AS attendee, e.title AS eventTitle
      FROM scan_log s LEFT JOIN tickets t ON t.id = s.ticket_id LEFT JOIN events e ON e.id = COALESCE(t.event_id, s.event_id)
      WHERE s.event_id = ? OR t.event_id = ?
      ORDER BY s.id DESC LIMIT 12`),
  };

  const publicEvent = (row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    venue: row.venue,
    startsAt: row.startsAt,
    capacity: row.capacity,
    registered: row.registered,
    remaining: Math.max(0, row.capacity - row.registered),
    soldOut: row.registered >= row.capacity,
  });
  const organizerEvent = (row) => ({ ...publicEvent(row), checkedIn: row.checkedIn });

  // ---- Registration -------------------------------------------------------------------------

  // Capacity check and insert happen in one write transaction, so two students
  // racing for the last seat can never both get it.
  const reserveSeat = transaction(db, (eventId, name, email) => {
    const event = stmt.getEvent.get(eventId);
    if (!event) throw new HttpError(404, 'EVENT_NOT_FOUND', 'That event doesn’t exist.');
    if (stmt.findTicket.get(eventId, email)) {
      throw new HttpError(409, 'ALREADY_REGISTERED', 'This email already has a ticket for this event.');
    }
    if (event.registered >= event.capacity) {
      throw new HttpError(409, 'SOLD_OUT', `${event.title} is full. All ${event.capacity} seats are taken.`);
    }
    const id = crypto.randomUUID();
    stmt.insertTicket.run(id, eventId, name, email);
    return { id, eventId, name, email };
  });

  function checkEmailDomain(email) {
    const allowed = config.allowedEmailDomains;
    if (allowed.length === 0) return;
    const domain = email.split('@')[1];
    if (!allowed.some((d) => domain === d || domain.endsWith(`.${d}`))) {
      throw new HttpError(400, 'EMAIL_DOMAIN', `Use your campus email address (${allowed.map((d) => `@${d}`).join(', ')}).`);
    }
  }

  async function deliverTicket(eventRow, ticket) {
    const token = tokens.issue(ticket.event_id ?? ticket.eventId, ticket.id);
    const event = publicEvent(eventRow);
    return mailer.sendTicket({ event, ticket: { id: ticket.id, name: ticket.name, email: ticket.email }, token });
  }

  // ---- Organizer sessions -------------------------------------------------------------------

  function requireOrganizer(req, res, next) {
    const match = /^Bearer (ORG1\.(\d{10,16}))\.([A-Za-z0-9_-]{43})$/.exec(req.get('authorization') || '');
    if (!match) return next(new HttpError(401, 'UNAUTHENTICATED', 'Sign in with the organizer passcode.'));
    const [, payload, expiry, signature] = match;
    const expected = Buffer.from(hmac(payload));
    const received = Buffer.from(signature);
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
      return next(new HttpError(401, 'UNAUTHENTICATED', 'Sign in with the organizer passcode.'));
    }
    if (Number(expiry) < Date.now()) return next(new HttpError(401, 'SESSION_EXPIRED', 'Your session expired. Sign in again.'));
    next();
  }

  // ---- Check-in -----------------------------------------------------------------------------

  const removeEvent = transaction(db, (eventId) => {
    const event = stmt.getEvent.get(eventId);
    if (!event) throw new HttpError(404, 'EVENT_NOT_FOUND', 'That event doesn’t exist.');
    if (event.registered > 0) {
      throw new HttpError(409, 'EVENT_HAS_TICKETS', `${event.title} already has ${event.registered} registration${event.registered === 1 ? '' : 's'}, so it can’t be deleted.`);
    }
    stmt.deleteEvent.run(eventId);
  });

  const checkInTransaction = transaction(db, (parsed, scopeEventId) => {
    const ticket = stmt.getTicket.get(parsed.ticketId);

    if (!ticket || ticket.event_id !== parsed.eventId) {
      stmt.logScan.run(scopeEventId, null, 'INVALID', 'unknown_ticket');
      return { status: 'INVALID', message: 'This code is signed correctly but no registration matches it.' };
    }

    const event = stmt.getEvent.get(ticket.event_id);
    const base = { attendee: { name: ticket.name }, event: { id: event.id, title: event.title } };

    if (scopeEventId && ticket.event_id !== scopeEventId) {
      stmt.logScan.run(scopeEventId, ticket.id, 'WRONG_EVENT', null);
      return { ...base, status: 'WRONG_EVENT', message: `This ticket is for ${event.title}. It was not checked in.` };
    }

    const now = new Date().toISOString();
    // The WHERE clause makes the first scan win, even with two scanners hitting it at once.
    if (Number(stmt.checkIn.run(now, ticket.id).changes) === 1) {
      stmt.logScan.run(ticket.event_id, ticket.id, 'CHECKED_IN', null);
      return { ...base, status: 'CHECKED_IN', message: 'Valid ticket. Let them in.', checkedInAt: now };
    }

    const firstScan = stmt.getTicket.get(ticket.id).checked_in_at;
    stmt.logScan.run(ticket.event_id, ticket.id, 'ALREADY_USED', null);
    return { ...base, status: 'ALREADY_USED', message: 'This ticket was already used.', checkedInAt: firstScan };
  });

  function verifyTicket(rawToken, scopeEventId) {
    const parsed = tokens.verify(rawToken);
    let result;
    if (!parsed.ok) {
      stmt.logScan.run(scopeEventId, null, 'INVALID', parsed.reason);
      result = {
        status: 'INVALID',
        message:
          parsed.reason === 'bad_signature'
            ? 'The signature check failed. This QR code was not issued by this system.'
            : 'This is not a ticket from this system.',
      };
    } else {
      result = checkInTransaction.immediate(parsed, scopeEventId);
    }
    return { ...result, label: STATUS_LABELS[result.status], scannedAt: new Date().toISOString() };
  }

  // ---- HTTP ---------------------------------------------------------------------------------

  const app = express();
  app.disable('x-powered-by');
  app.use(compression());
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    if (!req.path.startsWith('/dev/')) {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; " +
          "img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
      );
    }
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '8kb' }));

  const limiter = (windowMs, limit, message) =>
    rateLimit({
      windowMs,
      limit,
      standardHeaders: true,
      legacyHeaders: false,
      skip: () => config.disableRateLimit,
      handler: (req, res, next) => next(new HttpError(429, 'RATE_LIMITED', message)),
    });
  const limits = {
    register: limiter(10 * 60_000, 60, 'Too many registration attempts. Wait a few minutes and try again.'),
    resend: limiter(10 * 60_000, 10, 'Too many requests. Wait a few minutes and try again.'),
    login: limiter(15 * 60_000, 10, 'Too many sign-in attempts. Wait 15 minutes and try again.'),
    verify: limiter(60_000, 600, 'Scanning too fast. Wait a moment.'),
  };

  app.get('/api/meta', (req, res) => {
    res.json({ mailMode: mailer.mode, devOutbox: mailer.mode === 'outbox' && !config.production, orgName: config.orgName || '' });
  });

  // For uptime checks from the hosting platform. Touches the database so a broken disk shows up.
  app.get('/healthz', (req, res) => {
    db.prepare('SELECT 1').get();
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true });
  });

  app.get('/api/events', (req, res) => {
    res.json({ events: stmt.listEvents.all().map(publicEvent) });
  });

  app.get('/api/events/:id', (req, res) => {
    const event = stmt.getEvent.get(parseId(req.params.id));
    if (!event) throw new HttpError(404, 'EVENT_NOT_FOUND', 'That event doesn’t exist.');
    res.json({ event: publicEvent(event) });
  });

  app.post(
    '/api/events/:id/register',
    limits.register,
    wrap(async (req, res) => {
      const eventId = parseId(req.params.id);
      const name = cleanName(req.body?.name);
      const email = cleanEmail(req.body?.email);
      if (!name) throw new HttpError(400, 'INVALID_NAME', 'Enter your full name (2 to 80 characters).');
      if (!email) throw new HttpError(400, 'INVALID_EMAIL', 'Enter a valid email address.');
      checkEmailDomain(email);

      const ticket = reserveSeat.immediate(eventId, name, email);

      let delivery;
      try {
        delivery = await deliverTicket(stmt.getEvent.get(eventId), ticket);
      } catch (err) {
        // No ticket should exist if the student never received it: free the seat.
        stmt.deleteTicket.run(ticket.id);
        console.error(`[mail] delivery to ${email} failed: ${err.message}`);
        throw new HttpError(502, 'EMAIL_FAILED', 'We couldn’t send your ticket email, so no seat was held. Check the address and try again.');
      }

      res.status(201).json({
        registered: true,
        email,
        event: publicEvent(stmt.getEvent.get(eventId)),
        delivery: delivery.mode,
        preview: delivery.mode === 'outbox' && !config.production ? `/dev/outbox/${delivery.file}` : undefined,
      });
    })
  );

  app.post(
    '/api/events/:id/resend',
    limits.resend,
    wrap(async (req, res) => {
      const eventId = parseId(req.params.id);
      const email = cleanEmail(req.body?.email);
      if (!email) throw new HttpError(400, 'INVALID_EMAIL', 'Enter a valid email address.');
      const event = stmt.getEvent.get(eventId);
      if (!event) throw new HttpError(404, 'EVENT_NOT_FOUND', 'That event doesn’t exist.');

      const ticket = stmt.findTicket.get(eventId, email);
      let delivery;
      if (ticket && !ticket.checked_in_at) {
        try {
          delivery = await deliverTicket(event, ticket);
        } catch (err) {
          console.error(`[mail] resend to ${email} failed: ${err.message}`);
          throw new HttpError(502, 'EMAIL_FAILED', 'We couldn’t send the email. Try again in a few minutes.');
        }
      }
      // Same answer whether or not the address is registered, so this can't be used to probe.
      res.status(202).json({
        sent: true,
        preview: delivery?.mode === 'outbox' && !config.production ? `/dev/outbox/${delivery.file}` : undefined,
      });
    })
  );

  // Organizer portal API
  app.post('/api/organizer/login', limits.login, (req, res) => {
    const passcode = req.body?.passcode;
    if (typeof passcode !== 'string' || !crypto.timingSafeEqual(sha256(passcode), passcodeDigest)) {
      throw new HttpError(401, 'BAD_PASSCODE', 'That passcode is incorrect.');
    }
    const expiresAt = Date.now() + SESSION_HOURS * 3_600_000;
    const payload = `ORG1.${expiresAt}`;
    res.json({ token: `${payload}.${hmac(payload)}`, expiresAt: new Date(expiresAt).toISOString() });
  });

  app.get('/api/organizer/events', requireOrganizer, (req, res) => {
    res.json({ events: stmt.listEvents.all().map(organizerEvent) });
  });

  app.post('/api/organizer/events', requireOrganizer, (req, res) => {
    const input = parseEventInput(req.body);
    const info = stmt.insertEvent.run(input.title, input.description, input.venue, input.startsAt, input.capacity);
    res.status(201).json({ event: organizerEvent(stmt.getEvent.get(Number(info.lastInsertRowid))) });
  });

  app.delete('/api/organizer/events/:id', requireOrganizer, (req, res) => {
    removeEvent.immediate(parseId(req.params.id));
    res.json({ deleted: true });
  });

  app.get('/api/organizer/summary', requireOrganizer, (req, res) => {
    const events = stmt.listEvents.all().map(organizerEvent);
    const scope = req.query.eventId ? parseId(req.query.eventId) : null;
    const selected = scope ? events.filter((e) => e.id === scope) : events;
    if (scope && selected.length === 0) throw new HttpError(404, 'EVENT_NOT_FOUND', 'That event doesn’t exist.');
    res.json({
      registered: selected.reduce((n, e) => n + e.registered, 0),
      checkedIn: selected.reduce((n, e) => n + e.checkedIn, 0),
      capacity: selected.reduce((n, e) => n + e.capacity, 0),
      recent: scope ? stmt.recentForEvent.all(scope, scope) : stmt.recentAll.all(),
    });
  });

  app.post('/api/organizer/verify', requireOrganizer, limits.verify, (req, res) => {
    const token = req.body?.token;
    if (typeof token !== 'string' || token.trim() === '') {
      throw new HttpError(400, 'TOKEN_REQUIRED', 'No ticket code was provided.');
    }
    let scope = null;
    if (req.body?.eventId !== undefined && req.body.eventId !== null && req.body.eventId !== '') {
      scope = parseId(req.body.eventId);
    }
    res.json(verifyTicket(token, scope));
  });

  app.use('/api', (req, res, next) => next(new HttpError(404, 'NOT_FOUND', 'No such endpoint.')));

  // Development only: browse emails written to the outbox when no SMTP provider is configured.
  if (mailer.mode === 'outbox' && !config.production) {
    const outboxDir = mailer.outboxDir;
    app.get('/dev/outbox', (req, res) => {
      let files = [];
      try {
        files = fs.readdirSync(outboxDir).filter((f) => f.endsWith('.html')).sort().reverse();
      } catch {
        /* empty outbox */
      }
      const rows = files
        .map((f) => {
          const head = fs.readFileSync(path.join(outboxDir, f), 'utf8').slice(0, 400);
          const meta = /<!-- (.*?) -->/.exec(head)?.[1] ?? f;
          return `<li><a href="/dev/outbox/${encodeURIComponent(f)}">${meta}</a></li>`;
        })
        .join('');
      res
        .type('html')
        .setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      res.send(`<!doctype html><meta charset="utf-8"><title>Dev outbox</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#101A33}li{margin:6px 0}</style>
<h1>Dev outbox</h1><p>No SMTP provider is configured, so ticket emails land here instead of an inbox.</p>
${rows ? `<ul>${rows}</ul>` : '<p>No emails yet. Register for an event first.</p>'}`);
    });
    app.get('/dev/outbox/:file', (req, res, next) => {
      if (!/^[\w.-]+\.html$/.test(req.params.file)) return next();
      const file = path.join(outboxDir, req.params.file);
      if (!fs.existsSync(file)) return next();
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'");
      res.type('html').send(fs.readFileSync(file, 'utf8'));
    });
  }

  app.get('/vendor/jsQR.js', (req, res) => {
    res.sendFile(path.join(path.dirname(require.resolve('jsqr/package.json')), 'dist', 'jsQR.js'), { maxAge: '7d' });
  });

  // The home page is a template so the college name is in the first byte of HTML (no flash of default text).
  const publicDir = path.join(__dirname, '..', 'public');
  const orgAt = config.orgName ? `at ${esc(config.orgName)}` : 'on campus';
  const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8').replaceAll('{{ORG_AT}}', orgAt);
  app.get(['/', '/index.html'], (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(indexHtml);
  });

  app.use(
    express.static(publicDir, {
      extensions: ['html'],
      setHeaders(res, file) {
        if (file.endsWith('.woff2')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // font never changes in place
        else if (/\.(html|css|js)$/.test(file)) res.setHeader('Cache-Control', 'no-cache'); // always revalidate (cheap 304)
        else res.setHeader('Cache-Control', 'public, max-age=86400');
      },
    })
  );

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'The request body could not be read.' } });
    }
    console.error(err);
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Something went wrong on our side. Try again.' } });
  });

  return app;
}

module.exports = { createApp };
