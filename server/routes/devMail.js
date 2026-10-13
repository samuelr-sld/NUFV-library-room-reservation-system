import { Router } from 'express';

// Development and tests only: shows what the in-memory email sink "sent" (including one-time codes), so the approval
// flow can be tried without any mail server. app.js never mounts this in production or with a real transport.
const VIEWER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Demo email sink</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; background: #f4f6fb; color: #1d2433; }
  header { background: #0c235a; color: #fff; padding: 14px 20px; }
  header h1 { margin: 0; font-size: 18px; } header p { margin: 2px 0 0; font-size: 13px; opacity: .85; }
  main { max-width: 860px; margin: 18px auto; padding: 0 16px; }
  .mail { background: #fff; border-radius: 10px; padding: 14px 18px; margin-bottom: 12px; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  .mail h2 { margin: 0 0 4px; font-size: 16px; } .meta { font-size: 12px; color: #5a6275; margin-bottom: 8px; }
  pre { white-space: pre-wrap; word-break: break-word; margin: 0; font: inherit; }
  .code { background: #ffd700; color: #0c235a; font-weight: 700; padding: 0 6px; border-radius: 4px; letter-spacing: .08em; }
  .empty { color: #5a6275; text-align: center; padding: 40px 0; }
  select { font: inherit; padding: 4px 8px; }
</style></head><body>
<header><h1>Demo email sink</h1><p>Nothing here was sent anywhere. This is what the system would have emailed. Newest first, refreshed every 3 seconds.</p></header>
<main><label>Show mail to <select id="who"><option value="">everyone</option></select></label><div id="list"></div>
<h3>Account emails (Firebase Authentication, emulated)</h3><p class="meta">Verification and password-reset links. The emulator keeps them; nothing is sent.</p><div id="auth"></div></main>
<script>
  const list = document.getElementById('list'), who = document.getElementById('who'), seen = {};
  const changed = (key, value) => { const sig = JSON.stringify(value) + who.value; if (seen[key] === sig) return false; seen[key] = sig; return true; };
  function body(text) {
    const pre = document.createElement('pre');
    for (const part of text.split(/(https?:\\/\\/\\S+|\\b\\d{6}\\b)/)) {
      if (/^https?:\\/\\//.test(part)) { const a = document.createElement('a'); a.href = part; a.textContent = part; a.target = '_blank'; a.rel = 'noopener'; pre.append(a); }
      else if (/^\\d{6}$/.test(part)) { const s = document.createElement('span'); s.className = 'code'; s.textContent = part; pre.append(s); }
      else pre.append(part);
    }
    return pre;
  }
  async function load() {
    const { messages } = await (await fetch('/api/dev/mail')).json();
    const recipients = [...new Set(messages.map((m) => m.to))].sort();
    if (who.options.length - 1 !== recipients.length) who.replaceChildren(new Option('everyone', ''), ...recipients.map((r) => new Option(r, r)));
    const shown = messages.filter((m) => !who.value || m.to === who.value).reverse();
    if (!changed('list', shown)) return; // redraw only when something is new, so a click or a text selection is never lost
    list.replaceChildren(...(shown.length ? shown.map((m) => {
      const box = document.createElement('article'); box.className = 'mail';
      const h = document.createElement('h2'); h.textContent = m.subject;
      const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = 'To ' + m.to + ' · ' + m.kind + ' · ' + new Date(m.at).toLocaleTimeString();
      box.append(h, meta, body(m.text)); return box;
    }) : [Object.assign(document.createElement('p'), { className: 'empty', textContent: 'No email yet.' })]));
  }
  const AUTH_TITLES = { VERIFY_EMAIL: 'Verify your email address', PASSWORD_RESET: 'Reset your password', EMAIL_SIGNIN: 'Sign in' };
  async function loadAuth() {
    const { links } = await (await fetch('/api/dev/mail/auth-links')).json();
    const shown = links.filter((l) => !who.value || l.email === who.value).reverse();
    if (!changed('auth', shown)) return;
    document.getElementById('auth').replaceChildren(...(shown.length ? shown.map((l) => {
      const box = document.createElement('article'); box.className = 'mail';
      const h = document.createElement('h2'); h.textContent = AUTH_TITLES[l.type] ?? l.type;
      const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = 'To ' + l.email;
      box.append(h, meta, body((l.type === 'PASSWORD_RESET' ? 'Emulator: add &newPassword=YOUR_NEW_PASSWORD to the end of this address, then open it: ' : 'Open this link: ') + l.link)); return box;
    }) : [Object.assign(document.createElement('p'), { className: 'empty', textContent: 'No account emails yet.' })]));
  }
  who.addEventListener('change', () => { load(); loadAuth(); }); load(); loadAuth(); setInterval(() => { load(); loadAuth(); }, 3000);
</script></body></html>`;

export function devMailRouter({ mailer, config }) {
  const router = Router();
  router.get('/', (req, res) => {
    const to = typeof req.query.to === 'string' ? req.query.to.toLowerCase() : null;
    res.set('Cache-Control', 'no-store').json({ messages: mailer.adapter.messages.filter((m) => !to || m.to.toLowerCase() === to) });
  });
  // The Auth emulator's outgoing "emails" (verification and reset links), read from the emulator named in the environment, which
  // loadConfig has already proven is a loopback emulator of a demo project; this router is never mounted in production.
  router.get('/auth-links', async (req, res) => {
    const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
    const out = host ? await fetch(`http://${host}/emulator/v1/projects/${config.projectId}/oobCodes`).then((r) => r.json()).catch(() => ({})) : {};
    res.set('Cache-Control', 'no-store').json({ links: (out.oobCodes ?? []).map((c) => ({ email: c.email, type: c.requestType, link: c.oobLink })) });
  });
  router.get('/view', (req, res) => res.set('Cache-Control', 'no-store').type('html').send(VIEWER));
  return router;
}
