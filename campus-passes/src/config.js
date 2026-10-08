'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function csv(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function readOrCreateDevSecret(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, secret + '\n', { mode: 0o600 });
    return secret;
  }
}

/**
 * Reads and validates environment variables. Pure function of `env`, so tests
 * and scripts can call it with their own object.
 */
function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const warnings = [];
  const dbPath = env.DB_PATH ? path.resolve(env.DB_PATH) : path.join(ROOT, 'data', 'tickets.db');
  const outboxDir = env.OUTBOX_DIR ? path.resolve(env.OUTBOX_DIR) : path.join(ROOT, 'outbox');

  // Secret used to sign ticket tokens (and organizer sessions).
  let ticketSecret = env.TICKET_SIGNING_SECRET;
  if (!ticketSecret) {
    if (production) throw new Error('TICKET_SIGNING_SECRET is required when NODE_ENV=production.');
    ticketSecret = readOrCreateDevSecret(path.join(path.dirname(dbPath), '.dev-signing-secret'));
    warnings.push(
      'TICKET_SIGNING_SECRET is not set. Using a generated development secret stored beside the database. Set your own before deploying.'
    );
  } else if (ticketSecret.length < 32) {
    if (production) throw new Error('TICKET_SIGNING_SECRET must be at least 32 characters.');
    warnings.push('TICKET_SIGNING_SECRET is shorter than 32 characters.');
  }

  // Passcode organizers type into the scan portal.
  let organizerPasscode = env.ORGANIZER_PASSCODE;
  if (!organizerPasscode) {
    if (production) throw new Error('ORGANIZER_PASSCODE is required when NODE_ENV=production.');
    organizerPasscode = 'organizer-demo';
    warnings.push('ORGANIZER_PASSCODE is not set. Using the development passcode "organizer-demo".');
  }

  // Email delivery. With SMTP_HOST unset, emails are written to the outbox folder instead.
  let smtp = null;
  if (env.SMTP_HOST) {
    const port = Number(env.SMTP_PORT) || 587;
    smtp = {
      host: env.SMTP_HOST,
      port,
      secure: env.SMTP_SECURE ? /^(1|true|yes)$/i.test(env.SMTP_SECURE) : port === 465,
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
    };
    if (!env.MAIL_FROM) {
      throw new Error('MAIL_FROM is required when SMTP_HOST is set. Use a sender address your provider has verified.');
    }
  } else if (production) {
    warnings.push('SMTP_HOST is not set, so ticket emails are written to the outbox folder and NOT delivered.');
  }

  return {
    production,
    port: Number(env.PORT) || 3000,
    dbPath,
    outboxDir,
    ticketSecret,
    organizerPasscode,
    smtp,
    mailFrom: env.MAIL_FROM || 'Campus Passes <no-reply@campus-passes.local>',
    eventTimezone: env.EVENT_TIMEZONE || 'Asia/Kolkata',
    orgName: (env.ORG_NAME || '').trim().slice(0, 60),
    eventsFile: env.EVENTS_FILE ? path.resolve(env.EVENTS_FILE) : path.join(ROOT, 'events.json'),
    allowedEmailDomains: csv(env.ALLOWED_EMAIL_DOMAINS),
    trustProxy: env.TRUST_PROXY ? (Number.isNaN(Number(env.TRUST_PROXY)) ? env.TRUST_PROXY : Number(env.TRUST_PROXY)) : false,
    disableRateLimit: false,
    warnings,
  };
}

module.exports = { loadConfig };
