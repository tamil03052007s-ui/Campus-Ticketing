import { api, h, ticketCard } from './common.js';

const list = document.getElementById('events');

async function load() {
  try {
    const { events } = await api('/api/events');
    if (events.length === 0) {
      list.replaceChildren(h('p', { class: 'empty', text: 'No events are open for registration yet. Check back soon.' }));
      return;
    }
    list.replaceChildren(...events.map((event) => ticketCard(event, { href: `/register.html?event=${event.id}` })));
  } catch (err) {
    list.replaceChildren(
      h(
        'div',
        { class: 'notice error', role: 'alert' },
        h('p', { text: err.message }),
        h('button', { class: 'button secondary', type: 'button', onclick: load, text: 'Try again' })
      )
    );
  }
}

load();
