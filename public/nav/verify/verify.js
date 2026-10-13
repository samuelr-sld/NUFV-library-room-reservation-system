import { guardResult } from '../../js/guard.js';
import { session, HOME } from '../../js/session.js';
import { VERIFY_MESSAGES } from '../../js/verification.js';
import { demoMailNote } from '../../js/dom.js';

const COOLDOWN_SECONDS = 60; // Firebase rate-limits verification emails; this avoids hitting it by accident

if (guardResult.status === 'allow') {
  const status = document.getElementById('status');
  const resend = document.getElementById('resend');
  const refresh = document.getElementById('refresh');
  document.getElementById('account-email').textContent = guardResult.profile.email ?? '';

  const say = (outcome) => { status.textContent = VERIFY_MESSAGES[outcome]; status.dataset.outcome = outcome; };
  demoMailNote(status.parentElement); // local demo only: the verification link is in the demo email viewer, not in a mailbox

  async function check() {
    refresh.disabled = true;
    const outcome = await session.refreshVerification();
    say(outcome);
    if (outcome === 'verified') location.replace(HOME.student);
    else refresh.disabled = false;
  }
  refresh.addEventListener('click', check);

  resend.addEventListener('click', async () => {
    resend.disabled = true;
    const outcome = await session.sendVerificationEmail();
    say(outcome);
    if (outcome === 'error' || outcome === 'network') { resend.disabled = false; return; }
    // Sent or rate-limited: either way make the student wait before asking again.
    let left = COOLDOWN_SECONDS;
    const label = resend.textContent;
    const timer = setInterval(() => {
      resend.textContent = `${label} (${--left}s)`;
      if (left <= 0) { clearInterval(timer); resend.textContent = label; resend.disabled = false; }
    }, 1000);
  });

  // Already verified (for example on another device)? Skip the page.
  session.refreshVerification().then((outcome) => { if (outcome === 'verified') location.replace(HOME.student); });
}
