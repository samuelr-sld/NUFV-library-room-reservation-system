import { session, safeNext, LoginError, MESSAGES, HOME } from '../js/session.js';
import { notice, demoMailNote } from '../js/dom.js';

const loginForm = document.querySelector('.login-form');
const submitButton = loginForm.querySelector('.btn-primary');
const emailInput = document.getElementById('student-email');
const passwordInput = document.getElementById('password');
const passwordToggle = document.querySelector('.toggle-password');

function setFieldState(input, isValid) {
  const formGroup = input.closest('.form-group');
  const label = formGroup ? formGroup.querySelector('label') : null;
  const isInvalid = !isValid;

  input.classList.toggle('is-invalid', isInvalid);
  input.setAttribute('aria-invalid', String(isInvalid));

  if (label) {
    label.classList.toggle('is-invalid', isInvalid);
  }
}

function validateForm() {
  const emailValue = emailInput.value.trim();
  const passwordValue = passwordInput.value.trim();

  const emailIsValid = emailValue.length > 0;
  const passwordIsValid = passwordValue.length > 0;

  setFieldState(emailInput, emailIsValid);
  setFieldState(passwordInput, passwordIsValid);

  return emailIsValid && passwordIsValid;
}

passwordToggle.addEventListener('click', function () {
  const isPassword = passwordInput.type === 'password';

  passwordInput.type = isPassword ? 'text' : 'password';
  this.classList.toggle('fa-eye', !isPassword);
  this.classList.toggle('fa-eye-slash', isPassword);
});

let submitting = false;
let navigating = false; // exactly one thing decides where this page goes next, and it only does so once

// Where a signed-in person goes: the page they asked for (?next=) if it is one of the known pages for their role, else their home.
// replace(), not assign: the login page must not stay in the history behind the page they sign in to (Back would bounce them forward).
const next = new URLSearchParams(location.search).get('next');
function go(role) {
  if (navigating) return;
  navigating = true;
  window.location.replace(safeNext(next, role) ?? HOME[role]);
}

// The submit button starts disabled in the HTML, so a submit before this script runs cannot reload the page natively.
submitButton.disabled = false;

loginForm.addEventListener('submit', async function (event) {
  event.preventDefault();
  if (submitting) return;

  if (!validateForm()) {
    notice(loginForm, 'Please fill in all required fields.');
    return;
  }

  submitting = true;
  submitButton.disabled = true;
  notice(loginForm, '');
  try {
    const { role } = await session.login(emailInput.value.trim(), passwordInput.value);
    go(role); // the button stays disabled while the browser navigates
  } catch (error) {
    notice(loginForm, error instanceof LoginError ? error.message : MESSAGES.unavailable);
    submitting = false;
    submitButton.disabled = false;
  }
});

// A message from the page that sent the person here: signed out by a protected page (?reason=), or just registered (?registered=).
const REGISTERED = {
  sent: 'Account created. Check your email to verify your address, then log in.',
  'mail-failed': 'Account created, but the verification email could not be sent. You can request it again after logging in.',
};
const reason = new URLSearchParams(location.search).get('reason');
const registered = new URLSearchParams(location.search).get('registered');
if (reason in MESSAGES) notice(loginForm, MESSAGES[reason]);
else if (registered in REGISTERED) { notice(loginForm, REGISTERED[registered], { error: false }); demoMailNote(loginForm); }

// An existing valid session skips the form. Not while a sign-in is already under way: that one decides.
const restored = await session.check();
if (restored.status === 'allow' && !submitting) go(restored.profile.role);
