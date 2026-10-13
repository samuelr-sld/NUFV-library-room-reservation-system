# Production readiness (after Stage 9)

Nothing here has been deployed. No paid service has been chosen or enabled, no live email has been turned on, and no real credential exists in the repository. This document says what an operator needs, what was proven and how, and what still needs an owner decision.

**How to read the evidence.** Every claim below carries one of these labels:

| Label | Meaning |
|---|---|
| **Automated** | Covered by `npm test` (Node test runner; the emulator-backed ones run against the real Auth and Firestore emulators). |
| **Browser** | Exercised by hand in real Chrome against the local emulators, with the CSP applied through `npm run serve-public`. |
| **Emulator-only** | True of the emulators; real Firebase may differ (flagged where it matters). |
| **Production-only** | Cannot be checked locally; do it on a staging deployment. |
| **Hardware** | Needs a physical camera, scanner or printer. None of these were exercised. |

## 1. Environment variable checklist

The server refuses to start on anything ambiguous (`server/config.js`, **Automated**). Values below are formats only; generate real ones on the host.

| Variable | Required in production | Format / how to produce | Keep in |
|---|---|---|---|
| `NODE_ENV` | yes | `production` | host config |
| `FIREBASE_PROJECT_ID` | yes | the real project id (never `demo-*`) | host config |
| `FIREBASE_AUTH_EMULATOR_HOST`, `FIRESTORE_EMULATOR_HOST` | **must be unset** | refused if set in production | n/a |
| Firebase Admin credentials | yes | Application Default Credentials: the host's service account, or `GOOGLE_APPLICATION_CREDENTIALS=<path to a key file stored outside the repo>` | secret store |
| `CORS_ORIGINS` | yes | comma-separated bare https origins, e.g. the Hosting origin | host config |
| `APP_BASE_URL` | yes | bare https origin of the website; used in every approval link emailed | host config |
| `VOUCHER_ENCRYPTION_KEY` | yes | `openssl rand -base64 32` (44 characters ending in `=`) | secret store + offline backup |
| `APPROVAL_SECRET` | yes | `openssl rand -base64 32` | secret store + offline backup |
| `MAIL_TRANSPORT` | yes | `smtp` (`sink` is refused) | host config |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | yes with `smtp` | provider values | secret store (`SMTP_PASS`) |
| `MAIL_LIVE_APPROVED` | yes with `smtp` | `yes`, set only after the owner approves live mail | host config |
| `TRUST_PROXY_HOPS` | yes if behind any proxy | number of proxies in front of Express, 0 to 3 (default 0) | host config |
| `PORT` | optional | default 3000 | host config |

`server/.env.example` holds development values only; `.env` files are git-ignored. `PROD_API_BASE` in `public/js/firebase-config.js` is empty on purpose: set it to the API origin when the backend exists (and add that origin to `connect-src` if the policy is tightened, see section 4).

## 2. Secrets: persistence, backup, rotation

| Secret | If it is lost or replaced | Rotation procedure |
|---|---|---|
| `APPROVAL_SECRET` | Every outstanding approver code and session stops working. Nothing is lost: approvers ask for a new code. (**Automated**: restart tests.) | Pick a quiet hour, set the new value, restart. Approvers mid-decision just request another code. No data migration. Rotate on suspected exposure, and after anyone with access leaves. |
| `VOUCHER_ENCRYPTION_KEY` | Active Wi-Fi vouchers show "password unavailable"; ciphertext cannot be recovered. (**Automated**.) | Vouchers last at most `wifiVoucherMinutes` (max 24 h) and are demo credentials. Rotate by setting the new key and restarting; students regenerate vouchers. To avoid any "unavailable" voucher, wait for the last active voucher to expire first. |
| `SMTP_PASS` | Mail fails; messages stay queued and retry, then show as failed in Operations. | Rotate at the provider, update the host, restart. Failed messages can be sent again from Operations (except one-time codes). |
| Firebase Admin credentials | The API cannot reach Firestore or Auth. | Prefer the host's attached service account (nothing to rotate or leak). With a key file: create a new key, deploy it, delete the old key. |
| `APP_BASE_URL` | Links in emails already sent point at the old origin. | Keep the old origin redirecting to the new one for at least the longest approval deadline (`stepHours`, max 168 h). |

**Persistence and backup.** The two generated keys must exist before first start, live in the host's secret store, and be backed up **separately from the database** (a password manager or sealed offline copy). The server never writes them anywhere. In development the keys are random per start, which is why local approvals and vouchers do not survive a restart; production refuses to start without them. There is no dual-key window (the data they protect is short-lived, so none is needed); if that ever changes, the voucher box would need a key id.

## 3. Security audit

| Area | Finding | Status |
|---|---|---|
| Content-Security-Policy | Declared in `firebase.json` (section 4). Pages obey it: no inline script, style attribute, event handler or eval; every external origin is allowed. | **Automated** (`tests/unit/security.test.js`), **Browser** (inline script, inline style and a foreign script were all blocked; admin UI, Font Awesome and fonts load), real header delivery **Production-only** |
| Script loading and CDNs | Three third parties: Firebase SDK modules (gstatic, pinned to 13.0.0), Font Awesome CSS and fonts (cdnjs), Google Fonts. Font Awesome CSS has Subresource Integrity. SDK modules and Google Fonts cannot carry SRI. | **Automated**. Self-hosting them is the way to remove the gap (owner decision). |
| Security headers | CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN` (the Terms dialog is a same-site iframe: `DENY` would have broken it), `Referrer-Policy: no-referrer`, `Permissions-Policy: camera=(self), microphone=(), geolocation=()`. The API sets `nosniff` and `no-referrer` itself. | Config **Automated**; served by `npm run serve-public` **Browser**; the real Hosting delivery **Production-only** (the Hosting emulator ignores `headers`) |
| CORS | Exact-match allowlist, no credentials. A disallowed origin is refused outright (403) for anything that changes state, including the public approval endpoints, and gets no CORS headers on reads. | **Automated** |
| Rate limiting | Per-IP on the public approval endpoints (in-process flood guard, plus a Firestore-backed counter on code and verify), per-challenge limits, and a per-student limit on reservation submissions (each success emails the first approver). The in-process counter is per Express instance. | **Automated** |
| Authentication and authorization | Every `/api/admin`, `/api/tickets` and `/api/reservations` path, including paths that do not exist, answers 401 without a token and 403 for the wrong role (a structural guard, so routes added later are covered). Role and status come from the Firestore profile on every call. Registration, login, verification, recovery, session restore, suspension and role redirects were exercised. | **Automated**, **Browser** |
| Secret handling | Keys only from the environment; never logged or returned. Codes and sessions are stored as HMACs, voucher passwords as AES-GCM ciphertext. Audit log and viewer are free of secrets (tested with real flows). The dev mail viewer is not mounted in production. | **Automated** |
| Sensitive caching | Every `/api` response is `Cache-Control: no-store`, including errors. Static pages use Hosting defaults (public, short); they hold no user data. | **Automated** |
| Input validation | JSON bodies capped at 10 KB; every field validated and unknown fields refused; path and query parameters validated; malformed percent-escapes are a 400. | **Automated** |
| Error disclosure | Unexpected errors are logged on the server and answered with one generic message; framework header removed. | **Automated** |

## 4. Content-Security-Policy and headers

Applied to every path by `firebase.json`:

```
script-src 'self' https://www.gstatic.com;
style-src 'self' https://cdnjs.cloudflare.com https://fonts.googleapis.com;
font-src 'self' https://cdnjs.cloudflare.com https://fonts.gstatic.com;
frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'
```

This blocks injected scripts and inline styles, plugins, framing by other sites and form hijacking. It deliberately has **no `default-src` and no `connect-src`**: the exact hosts the Firebase Auth and Firestore SDKs contact (and the future API origin) could not be confirmed without a real project, and guessing wrong would break sign-in for everyone. Once a staging deployment exists, open the browser console on every page, confirm there are no violations, then add `connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firestore.googleapis.com <API origin>` (plus any host the console reports) to restrict where scripts can send data. **Production-only.**

Local check: run the emulators (Auth and Firestore), `npm run server`, then `npm run serve-public` and use `http://localhost:5000`; it serves `public/` with exactly the headers from `firebase.json`. After the first deploy run `curl -I https://<site>/approve/approve.html` and compare.

## 5. Firebase Spark

- **No Cloud Functions or Blaze feature is used.** Firestore, Authentication (email and password), Hosting. Scheduled work runs in the Express process or as `npm run` scripts.
- **The Express API cannot run on Spark** (no server runtime), so it needs outside hosting (section 6). Rewriting Hosting to Cloud Run or Functions would need Blaze and is not used.
- **Spark limits that matter** (check the current Firebase pricing page before launch): Firestore about 1 GiB stored, 50,000 reads, 20,000 writes and 20,000 deletes per day; Hosting about 10 GB stored and 360 MB transferred per day. When a daily quota is exhausted, calls fail until reset; the API answers 500 and nothing is half-written.
- **Where usage comes from.** A reservation is roughly 5 to 20 writes. Each approver code or verify request is 1 read and 1 write for its counter plus its transaction. Every authenticated API call re-reads the profile (1 read) and verifies the token with revocation checking. Anonymous traffic can only reach the approval endpoints, which are throttled per address.
- **Firestore backups are not available on Spark.** See section 10.
- **Rules** (`firestore.rules`): default deny; clients may read only their own `users/{uid}`. Deploy with `firebase deploy --only firestore:rules`.
- **Required composite indexes** (`firestore.indexes.json`). Single-field indexes are automatic. Deploy with `firebase deploy --only firestore:indexes` **before** first use; the emulator does not enforce them, so a missing one only fails in production (`FAILED_PRECONDITION`). **Emulator-only evidence:** not exercised on real Firestore.

| Collection | Fields | Used by |
|---|---|---|
| `tickets` | `uid` ↑, `issuedAt` ↓ | Student stub history |
| `tickets` | `resourceId` ↑, `status` ↑ | Consistency check safeguard |
| `reservations` | `uid` ↑, `startsAt` ↓ | My Reservations |
| `reservations` | `status` ↑, `startsAt` ↑ and `status` ↑, `startsAt` ↓ | Administrator queue |
| `reservations` | `status` ↑, `endedAt` ↓ | Operations: expired requests |
| `reservations` | `status` ↑, `endsAt` ↑ | Consistency check |
| `emailOutbox` | `status` ↑, `nextAttemptAt` ↑ | Outbox processor |
| `emailOutbox` | `status` ↑, `leaseUntil` ↑ | Outbox processor (abandoned leases) |
| `emailOutbox` | `status` ↑, `createdAt` ↓ | Operations: email list |
| `auditLogs` | `action` ↑, `at` ↓ and `targetId` ↑, `at` ↓ | Audit viewer filters |

## 6. External Express hosting, HTTPS, deployment and rollback

**Requirements.** Node.js 20 or newer, always running (it expires overdue requests every minute, sends queued mail every 10 seconds and answers approvers at any hour; a host that sleeps only delays those, nothing is lost because all of it is also done lazily and mail stays queued). Outbound access to Firestore, Firebase Auth and the SMTP server. One instance is recommended: several are safe for correctness (transactions, leases, idempotent sweeps) but multiply the in-process rate limit. Liveness probe: `GET /api/health` (no Firebase call). SIGTERM drains in-flight requests (10 s cap). No host has been chosen.

**HTTPS.** Required end to end. The website is https on Hosting; the API must be https too (`CORS_ORIGINS` and `APP_BASE_URL` must be https in production, enforced at startup), because the browser blocks mixed content and the QR scanner needs a secure context. Terminate TLS at the host or a reverse proxy and set `TRUST_PROXY_HOPS` to match. Turn on HSTS at the proxy or host edge (not set by the app, and not by Hosting config here).

**Deploy.** 1. Create the Firebase project; set `PROD_CONFIG` and `PROD_API_BASE` in `public/js/`. 2. Deploy rules and indexes. 3. Provision the host with the section 1 variables; first start with `MAIL_LIVE_APPROVED` unset and confirm it refuses; then set it. 4. `npm ci --omit=dev && node server/index.js` under a process manager that restarts on exit. 5. Bootstrap the first administrator (`npm run bootstrap-admin -- ... --confirm-project <id>`), then a second one. 6. `firebase deploy --only hosting`. 7. Smoke test: health, sign-in, one approval chain with test mailboxes, Operations and Audit Log, `curl -I` for the headers, a console check for CSP violations.

**Rollback.** Website: roll back to the previous release from the Hosting page of the Firebase console, or redeploy the previous build. API: redeploy the previous build with the same environment; it is stateless and every change is transactional, so a restart never loses data. Rules and indexes: redeploy the previous files (leave added indexes in place; they are harmless). Keys: never roll back a key rotation by guesswork, restore the backed-up value and restart. No migration exists in any release so far, so rollback needs no data step.

## 7. SMTP

An authenticated SMTP relay with a verified sender (`MAIL_FROM`) and SPF and DKIM on its domain, otherwise approval emails land in spam and the approval chain stalls. Port 465 uses TLS from the start; other ports use STARTTLS when offered. Volume is tens of messages a day. Delivery is **at least once** (rare duplicates). Failures show in Operations and can be sent again; one-time codes cannot. No provider has been chosen and nothing is sent until `MAIL_LIVE_APPROVED=yes`. Live delivery was never exercised (**unverified**).

## 8. Expected service quotas and costs

Estimates, not quotes; nothing is selected or approved.

| Item | Expectation |
|---|---|
| Firebase Spark | $0 while within the quotas in section 5; the single-campus library load is expected to fit, so watch the daily read and write counters in the Firebase console |
| Backend host | **Unknown, owner decision**: the smallest always-on instance, or $0 on existing university infrastructure |
| SMTP | **Unknown, owner decision**: $0 to a few dollars a month at this volume, or the university relay |
| Domain / TLS | $0 on `*.web.app` |

## 9. Monitoring and logging

The API logs to stdout and stderr (startup line, unexpected errors with stack, failed sweeps, failed outbox runs); it never logs secrets, codes or request bodies. There is no alerting. Minimum viable monitoring: an uptime probe on `GET /api/health`; the host's log retention; Firebase console usage graphs with an email alert on quota; a weekly look at Operations (failed email, locked approvals, expired requests) and the consistency check. Audit entries (including `approval.locked` and every `reconcile.*` repair) are the record of what happened.

## 10. Backup and recovery

- **Data.** Spark has no managed backup. Options: a scheduled `gcloud firestore export` needs a billing-enabled project (Blaze); on Spark the only route is a periodic script that reads the collections with the Admin SDK and stores the result offline. None exists yet (**owner decision**). Without it, the database is a single point of loss; the audit log, reservations and tickets cannot be rebuilt.
- **Keys:** section 2. **Code:** git. **Rules and indexes:** git.
- **Lost administrator access:** `npm run recover-admin` (operator, needs `--confirm-project`). Create a second administrator to avoid needing it.
- **Inconsistent data:** `npm run reconcile` (dry run by default). Repairs need `--apply`, and `--confirm-project` in production; each is re-verified in its own transaction and audited. It never releases a seat any active stub still points at, never touches a reservation's own holds, and reports (does not repair) anything needing a human decision. **Automated.**

## 11. Where institution-specific validation belongs (not yet enforced)

Nothing here guesses at the university's identifiers or domains.

- **Student number:** only a neutral safety rule is enforced (3 to 24 letters, digits or hyphens, stored upper-case so one number cannot be registered twice). Replace `STUDENT_NUMBER` in `server/policy.js` and its client copy in `public/register page/register.js` once the registrar confirms a format. **Browser**: a lowercase non-numeric number registered; the same number in another case was refused as a duplicate and the account was rolled back.
- **Email domain:** not restricted. Accounts are created in the browser straight against Firebase Authentication, and blocking that at creation needs a Blaze-only function, so on Spark the enforceable place is `createStudentProfile()` in `server/routes/students.js` (the verified token email is available there): without a profile an account cannot use any library service. Also configure Firebase Authentication's authorized domains and password policy in the console.
- **Participant student numbers** on a reservation use the same rule.

## 12. Verification record (Stage 9)

| What | How |
|---|---|
| Student Home shows real rooms (status for right now at the library), the student's own upcoming and pending reservations, and an honest announcements notice | **Browser** (desktop and 390 px), static guard **Automated** |
| Registration (including duplicate number rollback), verification, login, logout, session restore, suspension mid-session, no-profile and wrong-password messages, role redirects both ways, password reset (and one-time reset links) | **Browser** on emulators; underlying rules **Automated**. Email delivery is the emulator's: real verification and reset mail is **Production-only** |
| Silent Room, Computer Station, Wi-Fi voucher and confirmed reservation print: one page each, only the document visible, QR decodes (also at 60 % size), payload equals the API's, the admin scanner resolves it, quiet zone at least 4 modules | `tests/print/print-check.mjs` (headless Chrome, print media, PDF and PNG) **Browser-engine rendering**; paper and a physical printer are **Hardware, not exercised** |
| Both QR formats (NUFV1 stubs, NUFR1 reservations) | Decoded from the printed layouts, resolved by the scanner API (**Automated** and print-check) |
| Camera scanning | **Hardware: not exercised** |
| Real Firebase behavior, real headers, real SMTP | **Production-only** |

## 13. Remaining owner decisions and gaps

1. **Backend host** and **SMTP provider**: choose and approve.
2. **Backups** on Spark: decide whether to build the export script.
3. **Self-host the Firebase SDK, Font Awesome and fonts** to remove third-party script risk and allow a stricter CSP, or accept the CDNs.
4. **Tighten `connect-src`** after the first staging deploy (section 4).
5. **Institutional rules:** student number format, email domain, whether reservations get an attendance or no-show policy (printed texts no longer promise one), early-arrival grace for scanning.
6. **Distributed flood on the approval endpoints** could spend the free read quota; fixing it needs an edge limit or WAF.
7. **No alerting;** no break-glass second administrator by default; the audit log is append-only by convention, not infrastructure.
8. **Verify after first deploy:** headers, CSP console, composite indexes (run every admin screen and `npm run reconcile`), Firebase email templates and sender, real SMTP.
