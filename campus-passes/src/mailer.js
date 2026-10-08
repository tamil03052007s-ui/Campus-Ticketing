'use strict';

const fs = require('node:fs');
const path = require('node:path');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');

const QR_CID = 'ticket-qr';

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function formatWhen(iso, timeZone) {
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(new Date(iso));
}

/**
 * Builds the transactional email. Table layout and inline styles are deliberate:
 * that is what renders reliably across Gmail, Outlook and Apple Mail.
 * `qrSrc` is `cid:ticket-qr` for real delivery, or a data: URI for the dev outbox preview.
 */
function buildTicketEmail({ event, ticket, token, qrSrc, timeZone, orgName = '' }) {
  const when = formatWhen(event.startsAt, timeZone);
  const subject = `Your ticket for ${event.title}`;

  const text = [
    `Hi ${ticket.name},`,
    '',
    `You're registered for ${event.title}.`,
    `When:  ${when}`,
    `Where: ${event.venue}`,
    '',
    'Show the QR code in the HTML version of this email at the entrance.',
    'If your email app cannot show images, give the organizer this ticket code:',
    token,
    '',
    'The ticket works for one check-in. Please do not share it.',
  ].join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#E4E9F3;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#E4E9F3;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;color:#101A33;">
      <tr><td style="padding:0 4px 12px 4px;font-size:15px;font-weight:700;color:#101A33;">Campus Passes${orgName ? ` for ${esc(orgName)}` : ''}</td></tr>
      <tr><td style="background:#ffffff;border-radius:18px;overflow:hidden;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
          <tr><td style="background:#101A33;padding:28px 28px 24px 28px;">
            <div style="font-size:14px;line-height:20px;color:#B9C3E0;">You're registered, ${esc(ticket.name)}.</div>
            <div style="font-size:26px;line-height:32px;font-weight:700;color:#ffffff;margin-top:6px;">${esc(event.title)}</div>
          </td></tr>
          <tr><td style="padding:24px 28px 8px 28px;font-size:16px;line-height:24px;">
            <div style="font-weight:600;">${esc(when)}</div>
            <div style="color:#47526F;">${esc(event.venue)}</div>
          </td></tr>
          <tr><td align="center" style="padding:16px 28px 4px 28px;">
            <table role="presentation" cellspacing="0" cellpadding="0" style="border:2px dashed #CBD3E3;border-radius:14px;">
              <tr><td align="center" style="padding:18px;">
                <img src="${qrSrc}" width="240" height="240" alt="Ticket QR code for ${esc(event.title)}" style="display:block;width:240px;height:240px;border:0;background:#ffffff;">
              </td></tr>
            </table>
          </td></tr>
          <tr><td align="center" style="padding:12px 28px 4px 28px;font-size:14px;line-height:20px;color:#47526F;">
            Show this code at the entrance. It works for one check-in.
          </td></tr>
          <tr><td style="padding:16px 28px 28px 28px;">
            <div style="font-size:12px;line-height:18px;color:#47526F;margin-bottom:4px;">Can't see the image? Give this ticket code to the organizer:</div>
            <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:16px;word-break:break-all;background:#EEF1F8;border-radius:8px;padding:10px 12px;color:#101A33;"><code>${esc(token)}</code></div>
          </td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:16px 8px 0 8px;font-size:12px;line-height:18px;color:#47526F;">
        Please don't share this email. Anyone with the QR code can use your seat.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  return { subject, html, text };
}

function safeFilePart(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'ticket';
}

function createMailer({ smtp, mailFrom, outboxDir, eventTimezone, orgName = '' }) {
  const transport = smtp
    ? nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000,
      })
    : null;

  return {
    mode: transport ? 'smtp' : 'outbox',
    outboxDir,

    /** Checks SMTP credentials without sending anything. No-op in outbox mode. */
    async verify() {
      if (transport) await transport.verify();
    },

    /** Sends the ticket email. Throws if the provider rejects it. */
    async sendTicket({ event, ticket, token }) {
      const png = await QRCode.toBuffer(token, { type: 'png', errorCorrectionLevel: 'M', margin: 2, width: 480 });

      if (transport) {
        const { subject, html, text } = buildTicketEmail({
          event,
          ticket,
          token,
          qrSrc: `cid:${QR_CID}`,
          timeZone: eventTimezone,
          orgName,
        });
        const info = await transport.sendMail({
          from: mailFrom,
          to: { name: ticket.name, address: ticket.email },
          subject,
          text,
          html,
          attachments: [{ filename: 'ticket-qr.png', content: png, cid: QR_CID, contentType: 'image/png' }],
        });
        return { mode: 'smtp', messageId: info.messageId };
      }

      // Development fallback: write the email to disk so it can be opened in a browser.
      const { subject, html } = buildTicketEmail({
        event,
        ticket,
        token,
        qrSrc: `data:image/png;base64,${png.toString('base64')}`,
        timeZone: eventTimezone,
        orgName,
      });
      fs.mkdirSync(outboxDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = `${stamp}_${safeFilePart(ticket.email)}_${ticket.id.slice(0, 8)}.html`;
      const header = `<!-- to: ${esc(ticket.email)} | subject: ${esc(subject)} -->\n`;
      fs.writeFileSync(path.join(outboxDir, file), header + html);
      console.log(`[mail:outbox] ${ticket.email} -> outbox/${file}`);
      return { mode: 'outbox', file };
    },
  };
}

module.exports = { createMailer, buildTicketEmail };
