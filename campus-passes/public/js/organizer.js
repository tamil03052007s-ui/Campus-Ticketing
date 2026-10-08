import { api, h, session, formatClock, formatStamp, formatWhen, timeAgo } from './common.js';

const $ = (id) => document.getElementById(id);

const loginView = $('login-view');
const consoleView = $('console-view');
const video = $('video');
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

const state = {
  eventId: '',
  stream: null,
  scanning: false,
  verifying: false,
  lastToken: '',
  lastSeenAt: 0,
  lastTick: 0,
  audio: null,
};

const ICONS = { IDLE: '·', CHECKED_IN: '✓', ALREADY_USED: '!', INVALID: '✕', WRONG_EVENT: '⇄', ERROR: '!' };
const CHIP_TEXT = { CHECKED_IN: 'Checked in', ALREADY_USED: 'Already used', INVALID: 'Invalid', WRONG_EVENT: 'Wrong event' };

// ---- Sign in / out ------------------------------------------------------------------------

function showLogin(message) {
  stopCamera();
  consoleView.hidden = true;
  loginView.hidden = false;
  const box = $('login-error');
  box.replaceChildren(message ? h('p', { class: 'notice error', role: 'alert', text: message }) : '');
  $('passcode').focus();
}

async function loadEvents() {
  const { events } = await api('/api/organizer/events', { auth: true });
  const select = $('event-select');
  select.replaceChildren(
    h('option', { value: '', text: 'Any event' }),
    ...events.map((e) => h('option', { value: String(e.id), text: e.title }))
  );
  if (!events.some((e) => String(e.id) === state.eventId)) state.eventId = '';
  select.value = state.eventId;
  renderManageList(events);
}

async function showConsole() {
  loginView.hidden = true;
  consoleView.hidden = false;
  try {
    await loadEvents();
  } catch (err) {
    if (err.status === 401) return showLogin('Your session expired. Sign in again.');
  }
  setResult({ status: 'IDLE', label: 'Ready to scan', message: 'Hold a ticket’s QR code in front of the camera, or paste a ticket code below.' });
  refresh();

  api('/api/meta')
    .then((meta) => {
      $('dev-hint').hidden = !meta.devOutbox;
    })
    .catch(() => {});
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = e.submitter || e.target.querySelector('button');
  button.disabled = true;
  try {
    const { token } = await api('/api/organizer/login', { method: 'POST', body: { passcode: $('passcode').value } });
    session.token = token;
    $('passcode').value = '';
    showConsole();
  } catch (err) {
    showLogin(err.message);
  } finally {
    button.disabled = false;
  }
});

$('sign-out').addEventListener('click', () => {
  session.token = null;
  showLogin();
});

// ---- Result panel -------------------------------------------------------------------------

function setResult(r) {
  const panel = $('result');
  panel.dataset.status = r.status;
  $('result-icon').textContent = ICONS[r.status] || '·';
  $('result-label').textContent = r.label;
  $('result-name').textContent = r.attendee?.name || '';
  $('result-event').textContent = r.event?.title || '';

  let detail = r.message || '';
  if (r.status === 'CHECKED_IN') detail = `Checked in at ${formatStamp(r.checkedInAt)}`;
  if (r.status === 'ALREADY_USED') detail = `First checked in ${formatStamp(r.checkedInAt)} (${timeAgo(r.checkedInAt)})`;
  $('result-detail').textContent = detail;

  panel.classList.remove('pop');
  void panel.offsetWidth; // restart the animation
  if (r.status !== 'IDLE') panel.classList.add('pop');
}

function feedback(status) {
  if ($('sound').checked) {
    try {
      state.audio ||= new (window.AudioContext || window.webkitAudioContext)();
      const audio = state.audio;
      if (audio.state === 'suspended') audio.resume();
      const plan = status === 'CHECKED_IN' ? [[880, 0, 0.12]] : status === 'ALREADY_USED' ? [[440, 0, 0.14], [440, 0.2, 0.14]] : [[196, 0, 0.4]];
      for (const [freq, offset, length] of plan) {
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.frequency.value = freq;
        osc.type = status === 'CHECKED_IN' ? 'sine' : 'square';
        gain.gain.value = 0.08;
        osc.connect(gain).connect(audio.destination);
        osc.start(audio.currentTime + offset);
        osc.stop(audio.currentTime + offset + length);
      }
    } catch {
      /* audio is a nice-to-have */
    }
  }
  navigator.vibrate?.(status === 'CHECKED_IN' ? 80 : [120, 60, 120]);
}

// ---- Verification -------------------------------------------------------------------------

async function verify(token) {
  state.verifying = true;
  try {
    const result = await api('/api/organizer/verify', {
      method: 'POST',
      auth: true,
      body: { token, eventId: state.eventId || undefined },
    });
    setResult(result);
    feedback(result.status);
    refresh();
  } catch (err) {
    if (err.status === 401) return showLogin('Your session expired. Sign in again.');
    state.lastToken = ''; // let the same code be scanned again once the problem is fixed
    setResult({ status: 'ERROR', label: 'NOT VERIFIED', message: err.message });
    feedback('ERROR');
  } finally {
    state.verifying = false;
  }
}

$('manual-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('manual-token');
  const token = input.value.trim();
  if (!token || state.verifying) return;
  verify(token).then(() => {
    input.select();
  });
});

$('event-select').addEventListener('change', (e) => {
  state.eventId = e.target.value;
  refresh();
});

// ---- Camera scanning ----------------------------------------------------------------------

function onDecoded(token) {
  const now = Date.now();
  // The same code held in front of the camera counts as one scan until it leaves view for a moment.
  if (token === state.lastToken && now - state.lastSeenAt < 2500) {
    state.lastSeenAt = now;
    return;
  }
  if (state.verifying) return;
  state.lastToken = token;
  state.lastSeenAt = now;
  verify(token);
}

function scanLoop() {
  if (!state.scanning) return;
  const now = performance.now();
  if (now - state.lastTick >= 90 && video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth) {
    state.lastTick = now;
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.round(video.videoWidth * scale);
    const hh = Math.round(video.videoHeight * scale);
    if (canvas.width !== w || canvas.height !== hh) {
      canvas.width = w;
      canvas.height = hh;
    }
    ctx.drawImage(video, 0, 0, w, hh);
    const frame = ctx.getImageData(0, 0, w, hh);
    const code = window.jsQR(frame.data, w, hh, { inversionAttempts: 'dontInvert' });
    if (code && code.data) onDecoded(code.data);
  }
  requestAnimationFrame(scanLoop);
}

function cameraMessage(text) {
  $('camera-status').replaceChildren(text ? h('p', { class: 'notice error', role: 'alert', text }) : '');
}

async function startCamera() {
  cameraMessage('');
  if (!navigator.mediaDevices?.getUserMedia) {
    cameraMessage('This browser can’t open the camera here. Camera scanning needs HTTPS or localhost. Use the ticket code field below instead.');
    return;
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = state.stream;
    await video.play();
    state.scanning = true;
    $('viewfinder-idle').hidden = true;
    $('camera-toggle').textContent = 'Stop camera';
    requestAnimationFrame(scanLoop);
  } catch (err) {
    stopCamera();
    const messages = {
      NotAllowedError: 'Camera access is blocked. Allow it in your browser’s site settings, then try again. You can also use the ticket code field below.',
      NotFoundError: 'No camera was found on this device. Use the ticket code field below instead.',
      NotReadableError: 'The camera is in use by another app. Close it and try again.',
    };
    cameraMessage(messages[err.name] || 'The camera couldn’t start. Use the ticket code field below instead.');
  }
}

function stopCamera() {
  state.scanning = false;
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  video.srcObject = null;
  $('viewfinder-idle').hidden = false;
  $('camera-toggle').textContent = 'Start camera';
}

$('camera-toggle').addEventListener('click', () => (state.scanning ? stopCamera() : startCamera()));

// ---- Live counts and recent scans ---------------------------------------------------------

async function refresh() {
  if (consoleView.hidden) return;
  try {
    const query = state.eventId ? `?eventId=${encodeURIComponent(state.eventId)}` : '';
    const s = await api(`/api/organizer/summary${query}`, { auth: true });
    $('stat-in').textContent = String(s.checkedIn);
    $('stat-detail').textContent = `of ${s.registered} registered, ${s.capacity} seats`;
    $('recent').replaceChildren(
      ...s.recent.map((row) =>
        h(
          'li',
          {},
          h('span', { class: `chip chip-${row.result}`, text: CHIP_TEXT[row.result] || row.result }),
          h('span', { class: 'who', text: row.attendee || 'Unknown code' }),
          h('time', { datetime: row.at, text: formatClock(row.at) })
        )
      )
    );
    $('recent-empty').hidden = s.recent.length > 0;
  } catch (err) {
    if (err.status === 401) showLogin('Your session expired. Sign in again.');
  }
}

// Poll so a second scanner at another door shows up here within a few seconds.
setInterval(() => {
  if (!document.hidden) refresh();
}, 3000);

// ---- Manage events ------------------------------------------------------------------------

function renderManageList(events) {
  const list = $('manage-list');
  if (events.length === 0) {
    list.replaceChildren(h('li', {}, h('span', { class: 'hint', text: 'No events yet. Create one above.' })));
    return;
  }
  list.replaceChildren(
    ...events.map((ev) =>
      h(
        'li',
        {},
        h('div', { class: 'manage-info' }, h('strong', { text: ev.title }), h('span', { class: 'hint', text: `${formatWhen(ev.startsAt)}, ${ev.venue}` })),
        h('span', { class: 'hint', text: `${ev.registered} of ${ev.capacity} registered` }),
        h('button', {
          class: 'button secondary small',
          type: 'button',
          disabled: ev.registered > 0,
          title: ev.registered > 0 ? 'Events with registrations can’t be deleted' : null,
          'aria-label': `Delete ${ev.title}`,
          onclick: () => deleteEvent(ev),
          text: 'Delete',
        })
      )
    )
  );
}

function eventMessage(kind, text) {
  $('event-msg').replaceChildren(text ? h('p', { class: `notice ${kind}`, role: kind === 'error' ? 'alert' : 'status', text }) : '');
}

async function deleteEvent(ev) {
  if (!window.confirm(`Delete “${ev.title}”? This can’t be undone.`)) return;
  try {
    await api(`/api/organizer/events/${ev.id}`, { method: 'DELETE', auth: true });
    eventMessage('ok', `Deleted ${ev.title}.`);
    await loadEvents();
  } catch (err) {
    if (err.status === 401) return showLogin('Your session expired. Sign in again.');
    eventMessage('error', err.message);
  }
}

$('event-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  eventMessage('', '');
  const start = $('ev-start').value;
  if (!start) return eventMessage('error', 'Pick a start date and time.');
  const button = e.submitter || e.target.querySelector('button');
  button.disabled = true;
  try {
    const { event } = await api('/api/organizer/events', {
      method: 'POST',
      auth: true,
      body: {
        title: $('ev-title').value,
        venue: $('ev-venue').value,
        description: $('ev-desc').value,
        startsAt: new Date(start).toISOString(), // the picker gives local time; the server stores UTC
        capacity: Number($('ev-seats').value),
      },
    });
    e.target.reset();
    eventMessage('ok', `Created ${event.title}. It’s live on the events page.`);
    await loadEvents();
  } catch (err) {
    if (err.status === 401) return showLogin('Your session expired. Sign in again.');
    eventMessage('error', err.message);
  } finally {
    button.disabled = false;
  }
});

// ---- Start --------------------------------------------------------------------------------

if (session.token) showConsole();
else showLogin();
