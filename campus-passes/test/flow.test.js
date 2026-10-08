'use strict';

// End-to-end tests: real Express app, real SQLite file, real QR PNG decoded back with jsQR.
// Run with:  npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PNG } = require('pngjs');
const jsQR = require('jsqr');

const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { createMailer } = require('../src/mailer');
const { createTokenService } = require('../src/tokens');

const SECRET = 'test-secret-'.padEnd(48, 'x');
const PASSCODE = 'door-pass';
const TOKEN_RE = /CT1\.\d+\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/;

let dir;
let db;
let outbox;
let server;
let base;
let auth;
let bigEventId;
let smallEventId;

function makeConfig(extra = {}) {
  return {
    production: false,
    ticketSecret: SECRET,
    organizerPasscode: PASSCODE,
    smtp: null,
    mailFrom: 'Tests <tests@example.com>',
    eventTimezone: 'Asia/Kolkata',
    allowedEmailDomains: [],
    trustProxy: false,
    disableRateLimit: true,
    outboxDir: outbox,
    ...extra,
  };
}

async function call(method, url, { body, token } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const register = (eventId, name, email) => call('POST', `/api/events/${eventId}/register`, { body: { name, email } });
const scan = (token, eventId) => call('POST', '/api/organizer/verify', { body: { token, eventId }, token: auth });

/** Reads the newest outbox email addressed to `email` and returns { html, token }. */
function readEmail(email) {
  const slug = email.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const file = fs
    .readdirSync(outbox)
    .filter((f) => f.includes(slug))
    .sort()
    .pop();
  assert.ok(file, `no email in outbox for ${email}`);
  const html = fs.readFileSync(path.join(outbox, file), 'utf8');
  const token = TOKEN_RE.exec(html)?.[0];
  assert.ok(token, 'email contains a ticket token');
  return { html, token };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'passes-test-'));
  outbox = path.join(dir, 'outbox');
  db = openDb(path.join(dir, 'test.db'));
  const insert = db.prepare('INSERT INTO events (title, description, venue, starts_at, capacity) VALUES (?, ?, ?, ?, ?)');
  bigEventId = Number(insert.run('Big Show', 'desc', 'Hall A', '2030-01-01T10:00:00.000Z', 50).lastInsertRowid);
  smallEventId = Number(insert.run('Tiny Room', 'desc', 'Room 1', '2030-01-02T10:00:00.000Z', 3).lastInsertRowid);

  const config = makeConfig();
  const app = createApp({ config, db, mailer: createMailer(config) });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  const login = await call('POST', '/api/organizer/login', { body: { passcode: PASSCODE } });
  auth = login.body.token;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('lists events with live seat counts', async () => {
  const { status, body } = await call('GET', '/api/events');
  assert.equal(status, 200);
  const tiny = body.events.find((e) => e.id === smallEventId);
  assert.deepEqual([tiny.capacity, tiny.registered, tiny.remaining, tiny.soldOut], [3, 0, 3, false]);
});

test('registration emails a QR code that decodes to the signed ticket token', async () => {
  const res = await register(bigEventId, 'Asha Raman', 'asha@example.com');
  assert.equal(res.status, 201);
  assert.equal(res.body.delivery, 'outbox');

  const { html, token } = readEmail('asha@example.com');
  assert.match(html, /Big Show/);
  assert.match(html, /Asha Raman/);

  // Decode the embedded QR image and make sure it holds exactly that token.
  const b64 = /src="data:image\/png;base64,([^"]+)"/.exec(html)[1];
  const png = PNG.sync.read(Buffer.from(b64, 'base64'));
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  assert.ok(decoded, 'QR image is readable');
  assert.equal(decoded.data, token);
});

test('rejects bad input and duplicate registrations', async () => {
  assert.equal((await register(bigEventId, 'A', 'x@example.com')).body.error.code, 'INVALID_NAME');
  assert.equal((await register(bigEventId, 'Valid Name', 'not-an-email')).body.error.code, 'INVALID_EMAIL');
  const dup = await register(bigEventId, 'Asha Again', 'ASHA@example.com');
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'ALREADY_REGISTERED');
  assert.equal((await register(9999, 'Valid Name', 'x@example.com')).status, 404);
});

test('rejects registrations once capacity is reached', async () => {
  for (const n of [1, 2, 3]) {
    assert.equal((await register(smallEventId, `Student ${n}`, `s${n}@example.com`)).status, 201);
  }
  const full = await register(smallEventId, 'Late Student', 'late@example.com');
  assert.equal(full.status, 409);
  assert.equal(full.body.error.code, 'SOLD_OUT');

  const { body } = await call('GET', `/api/events/${smallEventId}`);
  assert.deepEqual([body.event.registered, body.event.remaining, body.event.soldOut], [3, 0, true]);
});

test('parallel registrations never exceed capacity', async () => {
  const id = Number(
    db.prepare('INSERT INTO events (title, venue, starts_at, capacity) VALUES (?, ?, ?, ?)').run('Race', 'Room 2', '2030-01-03T10:00:00.000Z', 4).lastInsertRowid
  );
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => register(id, `Racer ${i}`, `racer${i}@example.com`)));
  assert.equal(results.filter((r) => r.status === 201).length, 4);
  assert.equal(results.filter((r) => r.body?.error?.code === 'SOLD_OUT').length, 8);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE event_id = ?').get(id).n, 4);
});

test('a failed email frees the seat instead of holding a ticket nobody received', async () => {
  const failing = { mode: 'smtp', sendTicket: async () => { throw new Error('SMTP down'); } };
  const app = createApp({ config: makeConfig(), db, mailer: failing });
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const before = db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE event_id = ?').get(bigEventId).n;
  const original = console.error;
  console.error = () => {};
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/events/${bigEventId}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Mail Fail', email: 'fail@example.com' }),
    });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, 'EMAIL_FAILED');
  } finally {
    console.error = original;
    await new Promise((resolve) => srv.close(resolve));
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE event_id = ?').get(bigEventId).n, before);
});

test('organizer endpoints require a valid session', async () => {
  assert.equal((await call('POST', '/api/organizer/verify', { body: { token: 'x' } })).status, 401);
  assert.equal((await call('POST', '/api/organizer/verify', { body: { token: 'x' }, token: 'ORG1.9999999999999.' + 'a'.repeat(43) })).status, 401);
  assert.equal((await call('POST', '/api/organizer/login', { body: { passcode: 'wrong' } })).status, 401);
  assert.equal((await call('GET', '/api/organizer/summary')).status, 401);
});

test('first scan checks in, second scan reports ALREADY USED with the original timestamp', async () => {
  const { token } = readEmail('asha@example.com');

  const first = await scan(token);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'CHECKED_IN');
  assert.equal(first.body.label, 'CHECKED-IN');
  assert.equal(first.body.attendee.name, 'Asha Raman');
  assert.ok(first.body.checkedInAt);

  await new Promise((r) => setTimeout(r, 25));
  const second = await scan(token);
  assert.equal(second.body.status, 'ALREADY_USED');
  assert.equal(second.body.label, 'ALREADY USED');
  assert.equal(second.body.checkedInAt, first.body.checkedInAt);

  const row = db.prepare('SELECT checked_in_at FROM tickets WHERE email = ?').get('asha@example.com');
  assert.equal(row.checked_in_at, first.body.checkedInAt);
});

test('counterfeit and malformed codes are INVALID TICKET', async () => {
  const { token } = readEmail('s1@example.com');
  const [prefix, eventId, ticketId, sig] = token.split('.');

  const flipped = `${prefix}.${eventId}.${ticketId}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`;
  const otherEvent = `${prefix}.${eventId === '1' ? '2' : '1'}.${ticketId}.${sig}`;
  const forged = createTokenService('a-different-secret-'.padEnd(40, 'z')).issue(Number(eventId), ticketId);
  const unknown = createTokenService(SECRET).issue(Number(eventId), '123e4567-e89b-42d3-a456-426614174000');

  for (const bad of [flipped, otherEvent, forged, unknown, 'hello', 'CT1.1.x.y', token + 'x', 'A'.repeat(500), 'https://example.com/ticket/1']) {
    const res = await scan(bad);
    assert.equal(res.status, 200, `status for ${bad.slice(0, 20)}`);
    assert.equal(res.body.status, 'INVALID', `expected INVALID for ${bad.slice(0, 40)}`);
    assert.equal(res.body.label, 'INVALID TICKET');
  }

  // None of the bad scans may have consumed the real ticket.
  assert.equal((await scan(token)).body.status, 'CHECKED_IN');
  assert.equal((await call('POST', '/api/organizer/verify', { body: { token: '   ' }, token: auth })).status, 400);
});

test('simultaneous scans of one ticket check it in exactly once', async () => {
  const { token } = readEmail('s2@example.com');
  const results = await Promise.all(Array.from({ length: 8 }, () => scan(token)));
  const statuses = results.map((r) => r.body.status).sort();
  assert.deepEqual(statuses, ['ALREADY_USED', 'ALREADY_USED', 'ALREADY_USED', 'ALREADY_USED', 'ALREADY_USED', 'ALREADY_USED', 'ALREADY_USED', 'CHECKED_IN']);
});

test('scanning for a different event flags WRONG EVENT without using the ticket', async () => {
  const { token } = readEmail('s3@example.com'); // ticket for Tiny Room
  const wrong = await scan(token, bigEventId);
  assert.equal(wrong.body.status, 'WRONG_EVENT');
  assert.equal(db.prepare('SELECT checked_in_at FROM tickets WHERE email = ?').get('s3@example.com').checked_in_at, null);
  assert.equal((await scan(token, smallEventId)).body.status, 'CHECKED_IN');
});

test('summary reports live counts and recent scans', async () => {
  const { status, body } = await call('GET', `/api/organizer/summary?eventId=${smallEventId}`, { token: auth });
  assert.equal(status, 200);
  // s1, s2 and s3 were each checked in by the tests above.
  assert.equal(body.registered, 3);
  assert.equal(body.checkedIn, 3);
  assert.equal(body.capacity, 3);
  assert.ok(body.recent.length > 0);
  assert.ok(['CHECKED_IN', 'ALREADY_USED', 'WRONG_EVENT', 'INVALID'].includes(body.recent[0].result));
});

test('resend answers the same way for unknown addresses', async () => {
  const known = await call('POST', `/api/events/${bigEventId}/resend`, { body: { email: 'asha@example.com' } });
  const unknown = await call('POST', `/api/events/${bigEventId}/resend`, { body: { email: 'nobody@example.com' } });
  assert.equal(known.status, 202);
  assert.equal(unknown.status, 202);
});
