'use strict';

// Checks your mailer settings without touching the database:
//   npm run mail:test -- you@example.com
// It verifies the SMTP login, then sends a sample ticket email to the address you pass.
// (The sample ticket is signed but has no registration behind it, so scanning it reports INVALID TICKET.)

require('dotenv').config({ quiet: true });
const crypto = require('node:crypto');
const { loadConfig } = require('../src/config');
const { createMailer } = require('../src/mailer');
const { createTokenService } = require('../src/tokens');

async function main() {
  const to = process.argv[2];
  if (!to) {
    console.error('Usage: npm run mail:test -- you@example.com');
    process.exit(1);
  }

  const config = loadConfig();
  const mailer = createMailer(config);
  console.log(`Mail mode: ${mailer.mode}${config.smtp ? ` (${config.smtp.host}:${config.smtp.port})` : ' (no SMTP_HOST set, writing to the outbox folder)'}`);

  await mailer.verify();
  if (config.smtp) console.log('SMTP login verified.');

  const ticketId = crypto.randomUUID();
  const token = createTokenService(config.ticketSecret).issue(1, ticketId);
  const result = await mailer.sendTicket({
    event: {
      id: 1,
      title: 'Sample Event',
      venue: 'Main Auditorium',
      startsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    },
    ticket: { id: ticketId, name: 'Test Student', email: to },
    token,
  });
  console.log(result.mode === 'smtp' ? `Sent to ${to} (message id ${result.messageId}).` : `Saved to outbox/${result.file}`);
}

main().catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
