import { sendPasswordResetEmail } from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js';
import { auth } from '../js/firebase.js';
import { requestPasswordReset, RESET_MESSAGES } from '../js/password-reset.js';
import { notice, demoMailNote } from '../js/dom.js';

const form = document.querySelector('.register-form');
const emailInput = document.getElementById('student-email');
const submitButton = form.querySelector('.submit-button');
submitButton.disabled = false; // starts disabled in the HTML: a submit before this script runs must not reload the page natively
let submitting = false;

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting) return;
  submitting = true;
  submitButton.disabled = true;
  const label = submitButton.textContent;
  submitButton.textContent = 'SENDING...';

  const outcome = await requestPasswordReset((email) => sendPasswordResetEmail(auth, email), emailInput.value);
  emailInput.setAttribute('aria-invalid', String(outcome === 'invalid-email'));
  notice(form, RESET_MESSAGES[outcome], { error: outcome !== 'sent' });
  if (outcome === 'sent') demoMailNote(form);

  submitting = false;
  submitButton.disabled = false;
  submitButton.textContent = label;
});
