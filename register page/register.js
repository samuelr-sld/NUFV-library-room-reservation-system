import { auth, db } from '../firebase/firebase-config.js';
import { createUserWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { doc, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const registerForm = document.querySelector('.register-form');
const usernameInput = document.getElementById('username');
const studentNumberInput = document.getElementById('student-num');
const emailInput = document.getElementById('student-email');
const passwordInput = document.getElementById('password');
const confirmPasswordInput = document.getElementById('confirm-password');
const checkbox = document.querySelector('.legal-checkbox');

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
  const requiredFields = [usernameInput, studentNumberInput, emailInput, passwordInput, confirmPasswordInput];

  requiredFields.forEach((field) => {
    const isValid = field.value.trim().length > 0;
    setFieldState(field, isValid);
    if (!isValid) allValid = false;
  });

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

const requiredFields = [usernameInput, studentNumberInput, emailInput, passwordInput, confirmPasswordInput];
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

registerForm.addEventListener('submit', function (event) {
  event.preventDefault();

  if (!validateForm()) {
    return;
  }

  const username = usernameInput.value.trim();
  const studentNumber = studentNumberInput.value.trim();
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  const submitButton = registerForm.querySelector('.submit-button');

  submitButton.disabled = true;
  submitButton.textContent = 'CREATING ACCOUNT...';

  createUserWithEmailAndPassword(auth, email, password)
    .then((userCredential) => {
      const uid = userCredential.user.uid;

      return setDoc(doc(db, 'users', uid), {
        username: username,
        studentNumber: studentNumber,
        email: email,
        createdAt: new Date().toISOString()
      });
    })
    .then(() => {
      window.location.href = '../login page/login.html';
    })
    .catch((error) => {
      submitButton.disabled = false;
      submitButton.textContent = 'SUBMIT';
      alert('DEBUG ERROR:\n' + error.code + '\n' + error.message);
    });
});