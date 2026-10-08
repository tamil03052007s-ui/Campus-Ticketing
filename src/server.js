'use strict';

require('dotenv').config({ quiet: true });

const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { createMailer } = require('./mailer');
const { createApp } = require('./app');

const config = loadConfig();
config.warnings.forEach((w) => console.warn(`[config] ${w}`));

const db = openDb(config.dbPath, { seed: true, eventsFile: config.eventsFile });
if (db.seeded) console.log(`[db] new database: loaded ${db.seeded} events from ${config.eventsFile}`);
const mailer = createMailer(config);
const app = createApp({ config, db, mailer });

// Check SMTP credentials at startup so a typo shows up here, not on the first registration.
mailer
  .verify()
  .then(() => console.log(mailer.mode === 'smtp' ? `[mail] SMTP connection to ${config.smtp.host} verified` : '[mail] no SMTP configured: emails go to the outbox folder'))
  .catch((err) => console.error(`[mail] SMTP verification failed: ${err.message}`));

const server = app.listen(config.port, () => {
  console.log(`Campus Passes running at http://localhost:${config.port}`);
  console.log(`  Events:    http://localhost:${config.port}/`);
  console.log(`  Organizer: http://localhost:${config.port}/organizer.html`);
  if (mailer.mode === 'outbox' && !config.production) console.log(`  Dev mail:  http://localhost:${config.port}/dev/outbox`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { server };
