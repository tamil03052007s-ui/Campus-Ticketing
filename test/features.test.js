'use strict';

// Event management, college customization (VIT email domains, organization name),
// events.json seeding, and the performance headers.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { createMailer } = require('../src/mailer');

const SECRET = 'feature-secret-'.padEnd(48, 'y');
const PASSCODE = 'door-pass';
const ROOT = path.join(__dirname, '..');

let dir;
let db;
let server;
let base;
let auth;
const closers = [];

function makeConfig(extra = {}) {
  return {
    production: false,
    ticketSecret: SECRET,
    organizerPasscode: PASSCODE,
    smtp: null,
    mailFrom: 'Tests <tests@example.com>',
    eventTimezone: 'Asia/Kolkata',
    allowedEmailDomains: [],
    orgName: '',
    trustProxy: false,
    disableRateLimit: true,
    outboxDir: path.join(dir, 'outbox'),
    ...extra,
  };
}

async function listen(app) {
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  closers.push(() => new Promise((resolve) => srv.close(resolve)));
  return { srv, url: `http://127.0.0.1:${srv.address().port}` };
}

async function call(url, method, pathname, { body, token } = {}) {
  const res = await fetch(url + pathname, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'passes-features-'));
  db = openDb(path.join(dir, 'f.db'));
  const config = makeConfig();
  ({ srv: server, url: base } = await listen(createApp({ config, db, mailer: createMailer(config) })));
  auth = (await call(base, 'POST', '/api/organizer/login', { body: { passcode: PASSCODE } })).body.token;
});

after(async () => {
  for (const close of closers) await close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('organizers create and delete events; the public list updates', async () => {
  const good = {
    title: 'Quiz Night',
    venue: 'Hall B',
    description: 'Teams of four',
    startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    capacity: 40,
  };

  assert.equal((await call(base, 'POST', '/api/organizer/events', { body: good })).status, 401, 'needs a session');

  const created = await call(base, 'POST', '/api/organizer/events', { body: good, token: auth });
  assert.equal(created.status, 201);
  assert.equal(created.body.event.capacity, 40);
  assert.equal(created.body.event.remaining, 40);
  const id = created.body.event.id;

  const list = await call(base, 'GET', '/api/events');
  assert.ok(list.body.events.some((e) => e.id === id && e.title === 'Quiz Night'));

  // Each bad field is rejected with its own code.
  const cases = [
    [{ title: 'x' }, 'INVALID_TITLE'],
    [{ venue: '' }, 'INVALID_VENUE'],
    [{ startsAt: 'nope' }, 'INVALID_TIME'],
    [{ startsAt: new Date(Date.now() - 5 * 86_400_000).toISOString() }, 'INVALID_TIME'],
    [{ capacity: 0 }, 'INVALID_CAPACITY'],
    [{ capacity: 1.5 }, 'INVALID_CAPACITY'],
    [{ capacity: 'abc' }, 'INVALID_CAPACITY'],
    [{ description: 'd'.repeat(601) }, 'INVALID_DESCRIPTION'],
  ];
  for (const [patch, code] of cases) {
    const res = await call(base, 'POST', '/api/organizer/events', { body: { ...good, ...patch }, token: auth });
    assert.equal(res.status, 400, JSON.stringify(patch));
    assert.equal(res.body.error.code, code);
  }

  // Once someone has registered, the event can no longer be deleted.
  const reg = await call(base, 'POST', `/api/events/${id}/register`, { body: { name: 'Quiz Fan', email: 'quiz@example.com' } });
  assert.equal(reg.status, 201);
  const blocked = await call(base, 'DELETE', `/api/organizer/events/${id}`, { token: auth });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'EVENT_HAS_TICKETS');

  // An event with no registrations can be removed.
  const temp = await call(base, 'POST', '/api/organizer/events', { body: { ...good, title: 'Temp Event' }, token: auth });
  assert.equal((await call(base, 'DELETE', `/api/organizer/events/${temp.body.event.id}`, { token: auth })).status, 200);
  assert.equal((await call(base, 'GET', `/api/events/${temp.body.event.id}`)).status, 404);
  assert.equal((await call(base, 'DELETE', '/api/organizer/events/99999', { token: auth })).status, 404);
  assert.equal((await call(base, 'DELETE', `/api/organizer/events/${id}`)).status, 401);
});

test('organizer-entered text cannot inject markup into the emailed ticket', async () => {
  const created = await call(base, 'POST', '/api/organizer/events', {
    token: auth,
    body: { title: '<img src=x onerror=alert(1)>', venue: 'Hall <b>C</b>', startsAt: new Date(Date.now() + 86_400_000).toISOString(), capacity: 5 },
  });
  assert.equal(created.status, 201);
  const res = await call(base, 'POST', `/api/events/${created.body.event.id}/register`, { body: { name: 'Tag <i>Tester</i>', email: 'tags@example.com' } });
  assert.equal(res.status, 201);
  const html = fs.readFileSync(path.join(dir, 'outbox', fs.readdirSync(path.join(dir, 'outbox')).find((f) => f.includes('tags-example-com'))), 'utf8');
  assert.ok(!html.includes('<img src=x'), 'event title is escaped');
  assert.ok(!html.includes('<b>C</b>') && !html.includes('<i>Tester</i>'), 'venue and name are escaped');
  assert.ok(html.includes('&lt;img src=x'));
});

test('college customization: VIT email domains only, and the college name on the home page', async () => {
  const config = makeConfig({ allowedEmailDomains: ['vitstudent.ac.in', 'vit.ac.in'], orgName: 'VIT' });
  const { url } = await listen(createApp({ config, db, mailer: createMailer(config) }));

  const home = await (await fetch(url + '/')).text();
  assert.match(home, /<h1 class="page-title">Upcoming at VIT<\/h1>/);
  assert.match(home, /<title>Campus Passes \| Upcoming events at VIT<\/title>/);
  assert.ok(!home.includes('{{'), 'no template placeholders left');

  const eventId = (await call(url, 'GET', '/api/events')).body.events[0].id;
  const attempt = (email) => call(url, 'POST', `/api/events/${eventId}/register`, { body: { name: 'Test Student', email } });

  for (const bad of ['someone@gmail.com', 'x@evilvit.ac.in', 'x@vit.ac.in.evil.com', 'x@notvitstudent.ac.in']) {
    const res = await attempt(bad);
    assert.equal(res.status, 400, bad);
    assert.equal(res.body.error.code, 'EMAIL_DOMAIN');
  }
  assert.equal((await attempt('asha.23abc1234@vitstudent.ac.in')).status, 201);
  assert.equal((await attempt('Prof.Rao@VIT.AC.IN')).status, 201);

  // With no organization name configured the home page falls back to neutral wording.
  assert.match(await (await fetch(base + '/')).text(), /Upcoming on campus/);
});

test('events.json seeds an empty database with upcoming events, once', () => {
  const file = path.join(dir, 'seed.db');
  const eventsFile = path.join(ROOT, 'events.json');
  const first = openDb(file, { seed: true, eventsFile });
  const rows = first.prepare('SELECT title, starts_at, capacity FROM events').all();
  assert.ok(first.seeded >= 4 && first.seeded === rows.length);
  assert.ok(rows.some((r) => r.capacity === 5), 'keeps a tiny event for testing sold-out');
  for (const row of rows) assert.ok(new Date(row.starts_at).getTime() > Date.now(), `${row.title} is in the future`);
  first.close();

  const second = openDb(file, { seed: true, eventsFile });
  assert.equal(second.seeded, 0);
  assert.equal(second.prepare('SELECT COUNT(*) AS n FROM events').get().n, rows.length, 'no duplicates on restart');
  second.close();

  assert.equal(openDb(path.join(dir, 'none.db'), { seed: true, eventsFile: path.join(dir, 'missing.json') }).seeded, 0);

  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify([{ title: 'No venue', capacity: 10 }]));
  assert.throws(() => openDb(path.join(dir, 'bad.db'), { seed: true, eventsFile: bad }), /event #1 needs a title, a venue/);
});

test('health check, compression, cache and security headers', async () => {
  const health = await fetch(base + '/healthz');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const css = await fetch(base + '/css/app.css', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(css.headers.get('content-encoding'), 'gzip');
  assert.equal(css.headers.get('cache-control'), 'no-cache');
  assert.ok(css.headers.get('etag'), 'static files can be revalidated with a 304');

  const font = await fetch(base + '/fonts/bricolage-grotesque-latin.woff2');
  assert.equal(font.status, 200);
  assert.match(font.headers.get('cache-control'), /max-age=31536000, immutable/);

  const csp = (await fetch(base + '/')).headers.get('content-security-policy');
  assert.match(csp, /font-src 'self'/);
  assert.ok(!/google/.test(csp), 'no third-party hosts are allowed');

  for (const page of ['/', '/register.html', '/organizer.html']) {
    const html = await (await fetch(base + page)).text();
    assert.ok(!/googleapis|gstatic/.test(html), `${page} makes no third-party font requests`);
  }
});
