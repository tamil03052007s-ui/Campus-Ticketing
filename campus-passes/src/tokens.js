'use strict';

const crypto = require('node:crypto');

/**
 * Ticket token format:  CT1.<eventId>.<ticketId>.<signature>
 *
 *   signature = base64url( HMAC-SHA256( key, "CT1.<eventId>.<ticketId>" ) )
 *
 * The server never has to store the token. It re-derives the signature from the
 * ticket and event ids, so anyone without TICKET_SIGNING_SECRET cannot mint a
 * token that passes verification, and changing a single character breaks it.
 */
const PREFIX = 'CT1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_TOKEN_LENGTH = 200;

function createTokenService(secret) {
  // Domain-separated key so the raw secret is never used directly as an HMAC key.
  const key = crypto.createHash('sha256').update(`ticket-signing-v1:${secret}`).digest();

  const sign = (eventId, ticketId) =>
    crypto.createHmac('sha256', key).update(`${PREFIX}.${eventId}.${ticketId}`).digest('base64url');

  return {
    issue(eventId, ticketId) {
      return `${PREFIX}.${eventId}.${ticketId}.${sign(eventId, ticketId)}`;
    },

    /** Returns { ok: true, eventId, ticketId } or { ok: false, reason: 'malformed' | 'bad_signature' }. */
    verify(token) {
      if (typeof token !== 'string') return { ok: false, reason: 'malformed' };
      const value = token.trim();
      if (value.length === 0 || value.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'malformed' };

      const parts = value.split('.');
      if (parts.length !== 4 || parts[0] !== PREFIX) return { ok: false, reason: 'malformed' };

      const [, eventIdText, ticketId, signature] = parts;
      if (!/^[1-9]\d{0,9}$/.test(eventIdText) || !UUID_RE.test(ticketId)) {
        return { ok: false, reason: 'malformed' };
      }

      const expected = Buffer.from(sign(eventIdText, ticketId));
      const received = Buffer.from(signature);
      if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
        return { ok: false, reason: 'bad_signature' };
      }
      return { ok: true, eventId: Number(eventIdText), ticketId };
    },
  };
}

module.exports = { createTokenService };
