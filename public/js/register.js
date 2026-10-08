import { api, h, ticketCard } from './common.js';

const eventId = new URLSearchParams(location.search).get('event');
const title = document.getElementById('title');
const slot = document.getElementById('event-slot');
const panel = document.getElementById('form-panel');

let event = null;

function notFound(message) {
  title.textContent = 'Event not found';
  slot.replaceChildren();
  panel.replaceChildren(
    h('p', { class: 'notice error', role: 'alert', text: message }),
    h('a', { class: 'button', href: '/', text: 'Back to events' })
  );
}

function renderEvent(next) {
  event = next;
  document.title = `Register for ${event.title} | Campus Passes`;
  title.textContent = `Register for ${event.title}`;
  slot.replaceChildren(ticketCard(event));
}

function renderForm() {
  if (event.soldOut) {
    panel.replaceChildren(
      h('h2', { text: 'This event is full' }),
      h('p', { class: 'notice error', role: 'alert', text: `All ${event.capacity} seats are taken, so registration is closed.` }),
      h('a', { class: 'button', href: '/', text: 'Back to events' })
    );
    return;
  }

  const errorBox = h('div', { id: 'form-error', tabindex: '-1' });
  const nameInput = h('input', { id: 'name', name: 'name', type: 'text', autocomplete: 'name', required: true, minlength: '2', maxlength: '80' });
  const emailInput = h('input', { id: 'email', name: 'email', type: 'email', autocomplete: 'email', required: true, maxlength: '254', inputmode: 'email' });
  const submit = h('button', { class: 'button', type: 'submit', text: 'Register' });

  const form = h(
    'form',
    { novalidate: true },
    h('div', { class: 'field' }, h('label', { for: 'name', text: 'Full name' }), nameInput),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'email', text: 'Email address' }),
      emailInput,
      h('p', { class: 'hint', text: 'Your QR ticket is emailed here.' })
    ),
    submit
  );

  function showError(err) {
    const box = h('div', { class: 'notice error', role: 'alert' }, h('p', { text: err.message }));
    if (err.code === 'ALREADY_REGISTERED') {
      box.append(h('button', { class: 'button secondary', type: 'button', onclick: () => resend(emailInput.value.trim()), text: 'Send my ticket again' }));
    }
    errorBox.replaceChildren(box);
    errorBox.focus();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.replaceChildren();
    submit.disabled = true;
    submit.textContent = 'Registering…';
    try {
      const result = await api(`/api/events/${encodeURIComponent(eventId)}/register`, {
        method: 'POST',
        body: { name: nameInput.value, email: emailInput.value },
      });
      renderEvent(result.event);
      renderSuccess(result);
    } catch (err) {
      showError(err);
      if (err.code === 'SOLD_OUT') {
        try {
          renderEvent((await api(`/api/events/${encodeURIComponent(eventId)}`)).event);
          renderForm();
        } catch {
          /* keep the error message visible */
        }
      }
    } finally {
      submit.disabled = false;
      submit.textContent = 'Register';
    }
  });

  panel.replaceChildren(h('h2', { text: 'Your details' }), errorBox, form);
}

async function resend(email) {
  const status = document.getElementById('resend-status') || document.getElementById('form-error');
  try {
    const result = await api(`/api/events/${encodeURIComponent(eventId)}/resend`, { method: 'POST', body: { email } });
    status.replaceChildren(
      h(
        'div',
        { class: 'notice ok', role: 'status' },
        h('p', { text: `If ${email} has a ticket for this event, we just sent it again.` }),
        result.preview ? h('a', { href: result.preview, target: '_blank', rel: 'noopener', text: 'Open the email (development mode)' }) : null
      )
    );
  } catch (err) {
    status.replaceChildren(h('div', { class: 'notice error', role: 'alert' }, h('p', { text: err.message })));
  }
}

function renderSuccess(result) {
  panel.replaceChildren(
    h('h2', { text: 'You’re registered' }),
    h(
      'p',
      { class: 'notice ok', role: 'status' },
      'We emailed your QR ticket to ',
      h('strong', { text: result.email }),
      '. Show it at the entrance. It works for one check-in.'
    ),
    result.preview
      ? h(
          'p',
          { class: 'notice' },
          'Development mode: no email provider is set up, so the email was saved to a file. ',
          h('a', { href: result.preview, target: '_blank', rel: 'noopener', text: 'Open the email' })
        )
      : h('p', { class: 'hint', text: 'Can’t find it? Check your spam folder.' }),
    h('div', { id: 'resend-status', 'aria-live': 'polite' }),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'button secondary', type: 'button', onclick: () => resend(result.email), text: 'Send my ticket again' }),
      h('a', { class: 'button secondary', href: '/', text: 'Back to events' })
    )
  );
}

async function init() {
  if (!eventId) return notFound('Choose an event from the list to register.');
  try {
    renderEvent((await api(`/api/events/${encodeURIComponent(eventId)}`)).event);
    renderForm();
  } catch (err) {
    notFound(err.status === 404 ? 'That event doesn’t exist or was removed.' : err.message);
  }
}

init();
