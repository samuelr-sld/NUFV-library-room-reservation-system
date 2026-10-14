// Protects a page: <html hidden data-role="student|admin"> stays hidden until the session and profile are verified.
// A failure of any kind leaves the page hidden (fail closed). This is navigation UX, not authorization.
//
// Where a person goes (one place, so redirects cannot disagree):
//   no session / session lost elsewhere -> Login, remembering this page in ?next= (the login page only honors known pages for the
//                                          signed-in role, see safeNext); suspended or profile-less -> Login with a reason, nothing remembered
//   wrong role                           -> that role's own home
//   student without a verified email     -> the verification page
//   explicit log out                     -> Login, nothing remembered
import { session, safeNext, LOGIN_URL, VERIFY_URL } from './session.js';

const root = document.documentElement;
const role = root.dataset.role;
let leaving = false; // this page is already on its way out (log out): later sign-out events must not redirect again

const loginWithReturn = () => {
  const next = safeNext(location.pathname + location.hash, role);
  return next ? `${LOGIN_URL}?next=${encodeURIComponent(new URL(next).pathname + new URL(next).hash)}` : LOGIN_URL;
};

function showUnavailable() {
  const box = document.createElement('div');
  box.setAttribute('role', 'alert');
  box.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:#fff;font-family:Poppins,sans-serif;text-align:center;padding:24px';
  const text = document.createElement('p');
  text.textContent = 'We could not verify your session. Check your connection and try again.';
  const retry = document.createElement('button');
  retry.textContent = 'Try again';
  retry.addEventListener('click', () => location.reload());
  box.append(text, retry);
  document.body.append(box);
  root.hidden = false;
}

// Back/forward can restore a page exactly as it was left, signed-in content included, without running any script. Check again.
addEventListener('pageshow', (event) => { if (event.persisted) location.reload(); });

const result = await session.check(role, { requireVerified: root.dataset.requireVerified !== undefined });
export const guardResult = result; // pages that load their own data wait on this module, then check status === 'allow'

if (result.status === 'allow') {
  const name = result.profile.fullName;
  if (name) {
    document.querySelectorAll('.student-name, .highlight').forEach((el) => {
      el.textContent = el.classList.contains('highlight') ? `${name}!` : name;
    });
  }
  const number = result.profile.studentNumber; // the header link shows who you are: name and student number
  if (number) document.querySelectorAll('a.profile-section .student-course').forEach((el) => { el.textContent = number; });
  document.querySelectorAll('.logout').forEach((link) => link.addEventListener('click', async (event) => {
    event.preventDefault();
    leaving = true;
    await session.logout().catch(() => {});
    location.replace(LOGIN_URL);
  }));
  // Signed out somewhere else (another tab, an expired session): come back to this page after signing in again.
  session.onSignedOut(() => { if (!leaving) location.replace(loginWithReturn()); }).catch(() => {});
  root.hidden = false;
} else if (result.status === 'unverified') {
  location.replace(VERIFY_URL);
} else if (result.status === 'redirect') {
  location.replace(result.to);
} else if (result.status === 'login') {
  location.replace(result.reason ? `${LOGIN_URL}?reason=${result.reason}` : loginWithReturn());
} else {
  showUnavailable();
}
