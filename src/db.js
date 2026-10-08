'use strict';

const fs = require('node:fs');
const path = require('node:path');
// Built into Node 22.13+, so there is no native module to compile at install time.
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  venue       TEXT    NOT NULL,
  starts_at   TEXT    NOT NULL,
  capacity    INTEGER NOT NULL CHECK (capacity > 0),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS tickets (
  id            TEXT    PRIMARY KEY,
  event_id      INTEGER NOT NULL REFERENCES events(id),
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  checked_in_at TEXT,
  UNIQUE (event_id, email)
);
CREATE INDEX IF NOT EXISTS idx_tickets_event ON tickets(event_id);

-- Audit trail of every scan attempt, including counterfeit ones (no raw tokens stored).
CREATE TABLE IF NOT EXISTS scan_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER,
  ticket_id  TEXT,
  result     TEXT NOT NULL,
  detail     TEXT,
  scanned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_scan_log_time ON scan_log(scanned_at);
`;

/**
 * Wraps `fn` in a SQLite transaction. Call the result directly (deferred) or via `.immediate(...)`
 * to take the write lock up front, which is what the seat reservation and check-in use.
 * Throwing inside `fn` rolls everything back and rethrows.
 */
function transaction(db, fn) {
  const runIn = (begin) => (...args) => {
    db.exec(begin);
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw err;
    }
  };
  const run = runIn('BEGIN');
  run.immediate = runIn('BEGIN IMMEDIATE');
  return run;
}

const IST_OFFSET_MINUTES = 330;

/** Turns one entry of events.json into an ISO start time. Accepts `startsAt` (ISO) or `inDays` + `timeIST` ("HH:MM"). */
function resolveStart(entry) {
  if (entry.startsAt) {
    const date = new Date(entry.startsAt);
    if (Number.isNaN(date.getTime())) throw new Error(`events file: "${entry.title}" has an invalid startsAt`);
    return date.toISOString();
  }
  const days = Number(entry.inDays ?? 7);
  const [hour, minute] = String(entry.timeIST ?? '18:00').split(':').map(Number);
  if (!Number.isFinite(days) || !Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error(`events file: "${entry.title}" has an invalid inDays/timeIST`);
  }
  // Wall-clock time in India, `days` from today, so demo events are always upcoming.
  const nowIst = new Date(Date.now() + IST_OFFSET_MINUTES * 60_000);
  const utcMs = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate() + days, hour, minute) - IST_OFFSET_MINUTES * 60_000;
  return new Date(utcMs).toISOString();
}

function loadEventsFile(file) {
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Could not read events file ${file}: ${err.message}`);
  }
  if (!Array.isArray(entries)) throw new Error(`${file} must contain a JSON array of events`);
  return entries.map((e, i) => {
    if (typeof e.title !== 'string' || typeof e.venue !== 'string' || !Number.isInteger(e.capacity) || e.capacity < 1) {
      throw new Error(`${file}: event #${i + 1} needs a title, a venue and a whole-number capacity of at least 1`);
    }
    return [e.title, e.description || '', e.venue, resolveStart(e), e.capacity];
  });
}

/** Fills an empty database from events.json. Returns how many events were added. */
function seed(db, eventsFile) {
  const rows = eventsFile ? loadEventsFile(eventsFile) : null;
  if (!rows) return 0;
  const insert = db.prepare('INSERT INTO events (title, description, venue, starts_at, capacity) VALUES (?, ?, ?, ?, ?)');
  transaction(db, () => rows.forEach((row) => insert.run(...row)))();
  return rows.length;
}

function openDb(file, { seed: shouldSeed = false, eventsFile } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL'); // safe with WAL, noticeably faster writes
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  db.seeded = shouldSeed && db.prepare('SELECT COUNT(*) AS n FROM events').get().n === 0 ? seed(db, eventsFile) : 0;
  return db;
}

module.exports = { openDb, transaction };
