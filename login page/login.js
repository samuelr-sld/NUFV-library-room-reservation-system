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

  window.location.href = '../nav/main/main.html';
});
