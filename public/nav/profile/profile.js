// My Profile for students and administrators. The API (/api/profile) always acts on the signed-in user's own record and
// accepts only name, course and address; everything else here is read-only. Server data is always inserted as text.
import { sendPasswordResetEmail } from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js';
import { guardResult } from '../../js/guard.js';
import { apiFetch } from '../../js/api.js';
import { auth } from '../../js/firebase.js';
import { requestPasswordReset, RESET_MESSAGES } from '../../js/password-reset.js';
import { h, say, demoMailNote } from '../../js/dom.js';

const $ = (selector) => document.querySelector(selector);
const ROLES = { student: 'Student', admin: 'Administrator' };

function show(p) {
  $('#profile-facts').replaceChildren(...[
    ['Email', p.email], ['Role', ROLES[p.role] ?? p.role],
    ['Email verification', p.emailVerified ? 'Verified' : 'Not verified'],
    ...(p.studentNumber ? [['Student number', p.studentNumber]] : []),
  ].map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v))));
  $('#p-name').value = p.fullName;
  $('#p-program').value = p.program;
  $('#p-address').value = p.address;
  document.querySelectorAll('.student-name').forEach((el) => { el.textContent = p.fullName; });
  return p;
}

async function load() {
  const state = $('#profile-state');
  try {
    const { profile } = await apiFetch('/api/profile');
    show(profile);
    $(profile.role === 'admin' ? '#nav-admin' : '#nav-student').hidden = false;
    $('#profile-body').hidden = $('#details-form').hidden = false;
    $('#password-panel').hidden = !profile.passwordReset;
    state.hidden = true;
    return profile;
  } catch (err) {
    state.className = 'state error';
    state.textContent = err.message;
    state.append(h('button', { type: 'button', class: 'reserve-btn small', onclick: () => location.reload() }, 'Try again'));
  }
}

if (guardResult.status === 'allow') {
  const profile = await load();

  let saving = false;
  $('#details-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving) return;
    say($('#details-error'), '');
    say($('#details-notice'), '');
    const fullName = $('#p-name').value.trim();
    if (fullName.length < 2) return say($('#details-error'), 'Enter your full name (at least 2 characters).', true);
    saving = $('#details-save').disabled = true;
    try {
      const saved = await apiFetch('/api/profile', { method: 'PATCH', body: { fullName, program: $('#p-program').value, address: $('#p-address').value } });
      show(saved.profile);
      say($('#details-notice'), 'Profile saved.');
    } catch (err) {
      say($('#details-error'), err.message, true);
    } finally {
      saving = $('#details-save').disabled = false;
    }
  });

  $('#reset-password').addEventListener('click', async (event) => {
    event.target.disabled = true;
    // Always the signed-in account's own address, never something typed here.
    const outcome = await requestPasswordReset((email) => sendPasswordResetEmail(auth, email), profile?.email ?? '');
    say($('#reset-notice'), RESET_MESSAGES[outcome], outcome !== 'sent');
    if (outcome === 'sent') demoMailNote($('#password-panel'));
    event.target.disabled = false;
  });
}
