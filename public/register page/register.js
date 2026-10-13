import { createUserWithEmailAndPassword, signInWithEmailAndPassword, sendEmailVerification, signOut } from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js';
import { auth } from '../js/firebase.js';
import { apiFetch, retryUncertain } from '../js/api.js';
import { notice } from '../js/dom.js';

const STUDENT_NUMBER = /^[A-Z0-9][A-Z0-9-]{2,23}$/; // keep in sync with server/policy.js (no institutional format is enforced)

const registerForm = document.querySelector('.register-form');
const usernameInput = document.getElementById('username');
const studentNumberInput = document.getElementById('student-num');
const emailInput = document.getElementById('student-email');
const passwordInput = document.getElementById('password');
const confirmPasswordInput = document.getElementById('confirm-password');
const checkbox = document.querySelector('.legal-checkbox');
const submitButton = registerForm.querySelector('.submit-button');
submitButton.disabled = false; // starts disabled in the HTML: a submit before this script runs must not reload the page natively
const requiredFields = [usernameInput, studentNumberInput, emailInput, passwordInput, confirmPasswordInput];

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
  let allValid = true;

  requiredFields.forEach((field) => {
    const isValid = field.value.trim().length > 0;
    setFieldState(field, isValid);
    if (!isValid) allValid = false;
  });

  if (!STUDENT_NUMBER.test(studentNumberInput.value.trim().toUpperCase())) {
    setFieldState(studentNumberInput, false);
    allValid = false;
  }

  if (passwordInput.value.trim() && confirmPasswordInput.value.trim()) {
    const passwordMatch = passwordInput.value === confirmPasswordInput.value;

    if (!passwordMatch) {
      setFieldState(passwordInput, false);
      setFieldState(confirmPasswordInput, false);
      allValid = false;
    }
  }

  if (!checkbox.checked) {
    checkbox.classList.add('is-invalid');
    allValid = false;
  } else {
    checkbox.classList.remove('is-invalid');
  }

  return allValid;
}

requiredFields.forEach((field) => {
  field.addEventListener('input', () => {
    setFieldState(field, field.value.trim().length > 0);

    if (passwordInput.value && confirmPasswordInput.value) {
      const passwordsMatch = passwordInput.value === confirmPasswordInput.value;
      if (passwordsMatch) {
        setFieldState(passwordInput, true);
        setFieldState(confirmPasswordInput, true);
      }
    }
  });
});

checkbox.addEventListener('change', () => {
  checkbox.classList.remove('is-invalid');
});

document.querySelectorAll('.toggle-password').forEach((toggleIcon) => {
  toggleIcon.addEventListener('click', () => {
    const input = toggleIcon.parentElement.querySelector('input');
    const isPassword = input.type === 'password';

    input.type = isPassword ? 'text' : 'password';
    toggleIcon.classList.toggle('fa-eye', !isPassword);
    toggleIcon.classList.toggle('fa-eye-slash', isPassword);
  });
});

const AUTH_ERRORS = {
  'auth/email-already-in-use': 'An account with this email already exists.',
  'auth/invalid-email': 'Please enter a valid email address.',
  'auth/weak-password': 'Password must be at least 6 characters.',
  'auth/network-request-failed': 'Cannot reach the server. Please try again.',
};

registerForm.addEventListener('submit', async function (event) {
  event.preventDefault();

  if (!validateForm()) {
    return;
  }

  submitButton.disabled = true;
  notice(registerForm, '');
  const email = emailInput.value.trim();
  let user = null;
  let created = false;
  try {
    try {
      ({ user } = await createUserWithEmailAndPassword(auth, email, passwordInput.value));
      created = true;
    } catch (error) {
      if (error.code !== 'auth/email-already-in-use') throw error;
      // Possibly an earlier attempt whose outcome was never confirmed: resume it if the password proves ownership.
      try {
        ({ user } = await signInWithEmailAndPassword(auth, email, passwordInput.value));
      } catch {
        throw error;
      }
    }
    // The endpoint is idempotent, so re-sending while the outcome is unknown is safe.
    await retryUncertain(() => apiFetch('/api/students/profile', {
      method: 'POST',
      body: { fullName: usernameInput.value.trim(), studentNumber: studentNumberInput.value.trim() },
    }));
  } catch (error) {
    let message = AUTH_ERRORS[error.code] || error.message || 'Registration failed. Please try again.';
    if (error.status === 401) message = 'Your session expired before registration finished. Please submit the form again.';
    if (user && error.uncertain) {
      // The profile may exist, so the account must be kept. Submitting the same form again finishes the job.
      message = 'We could not confirm your registration. Please submit the form again with the same details.';
      await signOut(auth).catch(() => {});
    } else if (user && created && [400, 409].includes(error.status)) {
      // The server definitively refused the data (nothing was written): remove the account so the email can be reused.
      // Any other failure keeps the account; submitting the form again resumes it.
      await user.delete().catch(() => signOut(auth).catch(() => {}));
    } else if (user) {
      await signOut(auth).catch(() => {});
    }
    notice(registerForm, message);
    submitButton.disabled = false;
    return;
  }

  // The login page tells the student what happens next (see its ?registered= message).
  let result = 'sent';
  try {
    await sendEmailVerification(user);
  } catch {
    result = 'mail-failed';
  } finally {
    await signOut(auth);
    window.location.replace(`../login page/login.html?registered=${result}`);
  }
});
