import { auth } from '../firebase/firebase-config.js';
import { signInWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const loginForm = document.querySelector('.login-form');
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

loginForm.addEventListener('submit', function (event) {
  event.preventDefault();

  if (!validateForm()) {
    alert('Please fill in all required fields.');
    return;
  }

  const email = emailInput.value.trim();
  const password = passwordInput.value.trim();
  const submitButton = loginForm.querySelector('.btn-primary');

  submitButton.disabled = true;
  submitButton.textContent = 'LOGGING IN...';

  signInWithEmailAndPassword(auth, email, password)
    .then(() => {
      window.location.href = '../nav/main/main.html';
    })
    .catch((error) => {
      submitButton.disabled = false;
      submitButton.textContent = 'LOGIN';

      let message = 'Login failed. Please try again.';
      if (error.code === 'auth/invalid-credential' || error.code === 'auth/wrong-password') {
        message = 'Incorrect email or password.';
      } else if (error.code === 'auth/user-not-found') {
        message = 'No account found with that email.';
      } else if (error.code === 'auth/invalid-email') {
        message = 'Please enter a valid email address.';
      }
      alert(message);
    });
});