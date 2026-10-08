'use strict';

// Exercises the real SMTP code path (Nodemailer -> an in-process SMTP server) so the
// credentials, From address, inline CID image and attachment are all verified without a paid provider.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');
const { PNG } = require('pngjs');
const jsQR = require('jsqr');

const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { createMailer } = require('../src/mailer');

test('registration delivers a CID-embedded QR over authenticated SMTP', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'passes-smtp-'));
  const received = [];
  const smtpServer = new SMTPServer({
    authOptional: false,
    allowInsecureAuth: true,
    disabledCommands: ['STARTTLS'],
    onAuth(auth, session, cb) {
      if (auth.username === 'apikey' && auth.password === 'secret-key') return cb(null, { user: auth.username });
      cb(new Error('Invalid login'));
    },
    onData(stream, session, cb) {
      simpleParser(stream, { skipImageLinks: true }).then((mail) => {
        received.push(mail);
        cb();
      }, cb);
    },
  });
  await new Promise((resolve) => smtpServer.listen(0, '127.0.0.1', resolve));
  const smtpPort = smtpServer.server.address().port;

  const config = {
    production: false,
    ticketSecret: 's'.repeat(48),
    organizerPasscode: 'pass',
    smtp: { host: '127.0.0.1', port: smtpPort, secure: false, user: 'apikey', pass: 'secret-key' },
    mailFrom: 'Campus Passes <tickets@example.com>',
    eventTimezone: 'Asia/Kolkata',
    allowedEmailDomains: [],
    disableRateLimit: true,
    outboxDir: path.join(dir, 'outbox'),
  };
  const db = openDb(path.join(dir, 'smtp.db'));
  const eventId = Number(
    db.prepare('INSERT INTO events (title, venue, starts_at, capacity) VALUES (?, ?, ?, ?)').run('SMTP Gala', 'Hall', '2030-05-05T12:00:00.000Z', 10).lastInsertRowid
  );
  const mailer = createMailer(config);
  await mailer.verify(); // proves the credentials are accepted

  const app = createApp({ config, db, mailer });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/events/${eventId}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Meera Iyer', email: 'meera@example.com' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.delivery, 'smtp');
    assert.equal(body.preview, undefined);

    assert.equal(received.length, 1);
    const mail = received[0];
    assert.equal(mail.from.value[0].address, 'tickets@example.com');
    assert.equal(mail.to.value[0].address, 'meera@example.com');
    assert.equal(mail.subject, 'Your ticket for SMTP Gala');
    assert.match(mail.html, /src="cid:ticket-qr"/);
    assert.match(mail.text, /CT1\./);

    const qr = mail.attachments.find((a) => a.contentId === '<ticket-qr>' || a.cid === 'ticket-qr');
    assert.ok(qr, 'QR image is attached inline');
    assert.equal(qr.contentType, 'image/png');
    const png = PNG.sync.read(qr.content);
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    assert.match(decoded.data, /^CT1\.\d+\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    assert.ok(mail.html.includes(decoded.data), 'the plain-text fallback code matches the QR');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => smtpServer.close(resolve));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('wrong SMTP credentials fail verification and registration frees the seat', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'passes-smtp-bad-'));
  const smtpServer = new SMTPServer({
    allowInsecureAuth: true,
    disabledCommands: ['STARTTLS'],
    onAuth: (auth, session, cb) => cb(new Error('Invalid login')),
  });
  await new Promise((resolve) => smtpServer.listen(0, '127.0.0.1', resolve));

  const config = {
    production: false,
    ticketSecret: 's'.repeat(48),
    organizerPasscode: 'pass',
    smtp: { host: '127.0.0.1', port: smtpServer.server.address().port, secure: false, user: 'x', pass: 'y' },
    mailFrom: 'tickets@example.com',
    eventTimezone: 'UTC',
    allowedEmailDomains: [],
    disableRateLimit: true,
    outboxDir: path.join(dir, 'outbox'),
  };
  const db = openDb(path.join(dir, 'bad.db'));
  const eventId = Number(
    db.prepare('INSERT INTO events (title, venue, starts_at, capacity) VALUES (?, ?, ?, ?)').run('Bad Creds', 'Hall', '2030-05-05T12:00:00.000Z', 2).lastInsertRowid
  );
  const mailer = createMailer(config);
  await assert.rejects(() => mailer.verify());

  const app = createApp({ config, db, mailer });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const original = console.error;
  console.error = () => {};
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/events/${eventId}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'No Mail', email: 'nomail@example.com' }),
    });
    assert.equal(res.status, 502);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n, 0);
  } finally {
    console.error = original;
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => smtpServer.close(resolve));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
