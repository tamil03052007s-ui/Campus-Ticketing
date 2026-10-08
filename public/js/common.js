// Shared helpers. All DOM is built with createElement/textContent, never innerHTML,
// so event names and attendee names can't inject markup.

const TOKEN_KEY = 'organizerToken';

export const session = {
  get token() {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set token(value) {
    try {
      if (value) sessionStorage.setItem(TOKEN_KEY, value);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable: the session just won't survive a reload */
    }
  },
};

export async function api(path, { method = 'GET', body, auth = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && session.token) headers.Authorization = `Bearer ${session.token}`;

  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    const err = new Error('Can’t reach the server. Check your connection and try again.');
    err.status = 0;
    err.code = 'NETWORK';
    throw err;
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) {
    const err = new Error(data?.error?.message || 'Something went wrong. Try again.');
    err.status = res.status;
    err.code = data?.error?.code;
    throw err;
  }
  return data;
}

export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const whenFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});
const stampFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

export const formatWhen = (iso) => whenFormat.format(new Date(iso));
export const formatStamp = (iso) => stampFormat.format(new Date(iso));
export const formatClock = (iso) => clockFormat.format(new Date(iso));

export function timeAgo(iso) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** A ticket-shaped event card. Pass `href` to add the Register button. */
export function ticketCard(event, { href } = {}) {
  const taken = Math.min(100, Math.round((event.registered / event.capacity) * 100));
  const low = !event.soldOut && event.remaining / event.capacity <= 0.15;

  const fill = h('span', { class: 'meter-fill' });
  fill.style.width = `${taken}%`; // CSSOM, allowed by the page's CSP

  const seats = event.soldOut
    ? h('p', { class: 'seats' }, h('span', { class: 'seats-n', text: 'Full' }), h('span', { class: 'seats-l', text: `All ${event.capacity} seats taken` }))
    : h(
        'p',
        { class: 'seats' },
        h('span', { class: 'seats-n', text: String(event.remaining) }),
        h('span', { class: 'seats-l', text: `of ${event.capacity} seats left` })
      );

  let action = null;
  if (href) {
    action = event.soldOut
      ? h('span', { class: 'button is-disabled', 'aria-disabled': 'true', text: 'Sold out' })
      : h('a', { class: 'button', href, 'aria-label': `Register for ${event.title}`, text: 'Register' });
  }

  return h(
    'div',
    { class: 'ticket-slot' },
    h(
      'article',
      { class: `ticket${event.soldOut ? ' is-full' : ''}${low ? ' is-low' : ''}` },
      h(
        'div',
        { class: 'ticket-main' },
        h('h2', { class: 'ticket-title', text: event.title }),
        event.description ? h('p', { class: 'ticket-desc', text: event.description }) : null,
        h('p', { class: 'ticket-when', text: formatWhen(event.startsAt) }),
        h('p', { class: 'ticket-where', text: event.venue })
      ),
      h('div', { class: 'ticket-stub' }, seats, h('div', { class: 'meter', role: 'img', 'aria-label': `${taken}% of seats taken` }, fill), action)
    )
  );
}
