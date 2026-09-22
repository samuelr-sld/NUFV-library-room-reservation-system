document.addEventListener('DOMContentLoaded', function () {
  const loginForm = document.querySelector('.login-form');
  const emailInput = document.getElementById('student-email');
  const passwordInput = document.getElementById('password');
  const passwordToggle = document.querySelector('.toggle-password');

  if (passwordToggle && passwordInput) {
    passwordToggle.addEventListener('click', function () {
      const isPassword = passwordInput.type === 'password';
      passwordInput.type = isPassword ? 'text' : 'password';
      this.classList.toggle('fa-eye', !isPassword);
      this.classList.toggle('fa-eye-slash', isPassword);
    });
  }

  if (loginForm) {
    loginForm.addEventListener('submit', function (event) {
      event.preventDefault();

      const enteredEmail = emailInput ? emailInput.value.trim().toLowerCase() : '';
      const enteredPassword = passwordInput ? passwordInput.value.trim() : '';

      const usersDB = JSON.parse(localStorage.getItem('usersDB')) || [];
      const foundUser = usersDB.find(u => u.email === enteredEmail && u.password === enteredPassword);

      if (foundUser) {
        localStorage.setItem('currentUser', JSON.stringify({
          username: foundUser.username,
          studentNum: foundUser.studentNum,
          course: foundUser.course || 'BS Computer Engineering',
          email: foundUser.email
        }));
      } else {
        let fallbackName = enteredEmail.split('@')[0].replace(/[._]/g, ' ');
        fallbackName = fallbackName.replace(/\b\w/g, c => c.toUpperCase());

        localStorage.setItem('currentUser', JSON.stringify({
          username: fallbackName || 'Nationalian Student',
          studentNum: '2024-102938',
          course: 'BS Computer Engineering',
          email: enteredEmail
        }));
      }

      window.location.href = '../nav/main/main.html';
    });
  }
});