// Minimal Chrome DevTools Protocol driver for the hand-run browser checks (print-check.mjs, auth/nav-check.mjs): launches a
// headless Chrome, and hands out pages that each live in their own clean browser context (no shared cookies or storage).
// A page records every main-frame navigation, so a check can assert the exact chain of URLs a flow went through.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startChrome({ chrome = DEFAULT_CHROME } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-'));
  const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let log = '';
    proc.stderr.on('data', (d) => { log += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(log); if (m) resolve(m[1]); });
    proc.on('exit', () => reject(new Error(`Chrome exited: ${log.slice(-300)}`)));
    setTimeout(() => reject(new Error('Chrome did not start')), 15000);
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map(); // sessionId -> (method, params) => void
  ws.addEventListener('message', ({ data }) => {
    const m = JSON.parse(data);
    if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
    else if (m.method) listeners.get(m.sessionId)?.(m.method, m.params);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, sessionId })); });

  // A page in a fresh browser context. `navs` lists every main-frame URL in order (full navigations and history.pushState alike).
  async function openPage({ width = 1280, height = 900 } = {}) {
    const { browserContextId } = await send('Target.createBrowserContext');
    return attach(browserContextId, await send('Target.createTarget', { url: 'about:blank', browserContextId }), { width, height });
  }
  // A second page in the SAME browser context as `page` (same storage and sign-in: a second tab of one browser).
  async function openTab(page) {
    return attach(page.browserContextId, await send('Target.createTarget', { url: 'about:blank', browserContextId: page.browserContextId }), page.size);
  }
  async function attach(browserContextId, { targetId }, size) {
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const call = (m, p) => send(m, p, sessionId);
    const navs = [];
    const dialogs = [];
    const consoleErrors = []; // console errors, uncaught exceptions and blocked resources (a CSP violation shows up here too)
    listeners.set(sessionId, (method, params) => {
      if (method === 'Runtime.exceptionThrown') consoleErrors.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
      if (method === 'Runtime.consoleAPICalled' && params.type === 'error') consoleErrors.push(params.args.map((a) => a.value ?? a.description).join(' '));
      if (method === 'Log.entryAdded' && params.entry.level === 'error') consoleErrors.push(`${params.entry.text} ${params.entry.url ?? ''}`.trim());
      if (method === 'Page.frameNavigated' && !params.frame.parentId) navs.push(params.frame.url);
      if (method === 'Page.navigatedWithinDocument') navs.push(params.url);
      if (method === 'Page.javascriptDialogOpening') { dialogs.push(params.message); call('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); }
    });
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Log.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
    const run = async (expression) => {
      const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const until = async (expression, what, ms = 30000) => { // generous: every fresh browser downloads the Firebase SDK from Google's CDN
      for (let t = 0; t < ms; t += 100) { try { if (await run(expression)) return; } catch { /* the page is between documents */ } await sleep(100); }
      const slow = await run("performance.getEntriesByType('resource').filter((r) => r.responseEnd === 0 || r.duration > 4000).map((r) => r.name.replace(/^https?:\/\//, '').slice(0, 60) + ' ' + Math.round(r.duration) + 'ms').slice(0, 4).join(', ')").catch(() => '');
      throw new Error(`timed out waiting for ${what} (at ${await run('location.href').catch(() => '?')}; navigations: ${navs.join(' > ')}${slow ? `; slow or unfinished requests: ${slow}` : ''})`);
    };
    const go = async (url) => { await call('Page.navigate', { url }); await sleep(300); await until("document.readyState === 'complete'", `${url} to load`); };
    // A real phone viewport (touch, mobile layout) or the desktop one; the layout is what a user at that size sees.
    const setViewport = async (width, height, mobile = false) => {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      await call('Emulation.setTouchEmulationEnabled', { enabled: mobile });
    };
    const shot = async (file, { fullPage = false } = {}) => {
      const r = await call('Page.captureScreenshot', { format: 'jpeg', quality: 55, captureBeyondViewport: fullPage });
      writeFileSync(file, Buffer.from(r.data, 'base64'));
    };
    return {
      call, run, until, go, navs, dialogs, consoleErrors, setViewport, shot, browserContextId, size,
      path: () => run('location.pathname + location.search + location.hash'),
      // Waits for redirects to finish: first for a protected page's guard to decide (the page is hidden until it does), then until the
      // address has stayed the same for `ms`. Returns the address the page settled on.
      settle: async (ms = 1500) => {
        const read = () => run('location.pathname + location.search + location.hash').catch(() => '');
        const first = await read();
        for (let t = 0; t < 30000; t += 200) {
          const hidden = await run('document.documentElement.hidden').catch(() => false);
          if (!hidden || (await read()) !== first) break;
          await sleep(200);
        }
        let last = await read();
        let since = Date.now();
        while (Date.now() - since < ms) { await sleep(150); const now = await read(); if (now !== last) { last = now; since = Date.now(); } }
        return last;
      },
      close: () => { listeners.delete(sessionId); return call('Target.closeTarget', { targetId }).catch(() => {}); },
    };
  }
  const disposeContext = (page) => send('Target.disposeBrowserContext', { browserContextId: page.browserContextId }).catch(() => {});
  return { openPage, openTab, send, disposeContext, close: () => { ws.close(); proc.kill(); } };
}
