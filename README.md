# NUFV Library Services

Discussion room reservation system: static HTML/CSS/vanilla JS frontend (`public/`, served by Firebase Hosting), a Node.js + Express 5 API (`server/`), Firebase Authentication and Cloud Firestore. Development runs entirely on the Firebase Emulator Suite with the `demo-nufv` project; nothing in development or tests touches production Firebase.

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 20.6 or newer (developed on 24) | Includes npm. The scripts use `node --env-file` and `node --test`. |
| Firebase CLI (global compiler/tooling) | `firebase-tools` 15.x | `npm install -g firebase-tools`; provides the Auth/Firestore/Hosting emulators. |
| Java JDK | 21 or newer | Required by the Firestore emulator (see "One-time: Java 21" below). |
| Google Chrome | Current | Only for the optional browser checks (`npm run test:browser` etc.) and the camera scanner. |
| Internet access | | The pages load the Firebase SDK from Google's CDN. |

No language compiler is needed: the frontend is plain HTML/CSS/JavaScript and the API runs directly on Node.js.

## VS Code Extensions Required

| Extension | Publisher | Why |
|---|---|---|
| Live Preview (`ms-vscode.live-server`) | Microsoft | Optional: quick look at static pages in `public/`. The full system must be opened through `http://localhost:5000` (the API and Firebase emulators are needed for sign-in and data). |

VS Code's built-in JavaScript/Node.js support is enough; no language extension or debugger add-on is required. Everything else runs from the integrated terminal.

## Execution Steps (VS Code Integrated Terminal)

Open the project folder in VS Code, then open the terminal with `` Ctrl + ` `` (PowerShell).

**Quickest: the one-command academic demo**

```powershell
# 1. Use Java 21 for this terminal session (see "One-time: Java 21" if `java -version` is not 21.x)
$env:JAVA_HOME = 'C:\Program Files\Microsoft\jdk-21.0.12.101-hotspot'
$env:Path = "$env:JAVA_HOME\bin;$env:Path"

# 2. Install dependencies (first time only)
npm install

# 3. Start emulators, API, website, email sink and demo accounts together
npm run demo
```

Open <http://localhost:5000/login%20page/login.html>. Every demo account uses the password `demo1234`. Press `Ctrl + C` in the terminal to stop. The classroom walkthrough with accounts and steps is in [docs/demo-guide.md](docs/demo-guide.md).

**Manual start (two terminals)**

```powershell
npm run emulators   # terminal 1 (Ctrl + Shift + ` opens a second one)
npm run server      # terminal 2, API on http://localhost:3000
```

**Run the tests**

```powershell
npm test            # stop the demo first; both use the same emulator ports
```

## Local development on Windows

### One-time: Java 21 (required by the Firestore emulator)

`firebase-tools` needs Java 21 or newer. On this machine `java` on `PATH` resolves to the Oracle Java 8 shim (`C:\Program Files (x86)\Common Files\Oracle\Java\java8path\java.exe`), which comes first and wins, even though JDK 21 is installed at `C:\Program Files\Microsoft\jdk-21.0.12.101-hotspot`. Symptom: `firebase-tools no longer supports Java version before 21`.

Per terminal session (PowerShell), before starting the emulators or running tests:

```powershell
$env:JAVA_HOME = 'C:\Program Files\Microsoft\jdk-21.0.12.101-hotspot'
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
java -version   # must print 21.x
```

Permanent fix: Windows Settings > System > About > Advanced system settings > Environment Variables. Set the user variable `JAVA_HOME` to the JDK path above, and move `%JAVA_HOME%\bin` to the top of the user `Path` (above the Oracle `java8path` entry). Open a new terminal afterwards.

### Start everything

```powershell
npm install
npm run emulators   # terminal 1: Auth 9099, Firestore 8080, Hosting 5000, Emulator UI 4000
npm run server      # terminal 2: Express API on http://localhost:3000
```

Open <http://localhost:5000>. `npm run server` loads `server/.env.example` (demo project, emulator hosts). The server refuses to start if its environment is ambiguous (see `server/config.js`); it never falls back to production Firebase.

### Tests

```powershell
npm test   # starts the Auth, Firestore and Hosting emulators, runs every test, shuts them down
```

### Academic demonstration environment

```powershell
npm run demo        # emulators + API + website + email sink + demo accounts and inventory, in one command; Ctrl+C stops it
```

Opens at <http://localhost:5000/login%20page/login.html>; the demo email sink viewer (what approvers and students would receive, including one-time codes) is at <http://localhost:3000/api/dev/mail/view>. Every demo account uses the password `demo1234` (demonstration-only). It runs only against the local emulators of a `demo-*` project and refuses anything else; each start is a clean slate. `npm run demo:seed` and `npm run demo:reset` seed or wipe-and-seed an emulator you started yourself.

* **`docs/demo-guide.md`**: the classroom walkthrough (prerequisites, accounts, sequence, simulated email approval, QR verification, recovery if a step fails).
* **`docs/gmail-smtp-setup.md`**: optional live email through a dedicated Gmail account (off by default; the demo never uses it), with the safe one-message test `npm run mail:test`.
* **`docs/test-matrix.md`**: every behavior checked, expected versus actual, automated versus observed, with evidence in `docs/evidence/`.

Optional browser checks (need Chrome, and `npm run demo` running in another terminal; they are not part of `npm test`, and `npm test` needs the demo stopped because both use the emulator ports):

| Command | What it does |
|---|---|
| `npm run test:browser` | 16 sign-in navigation scenarios (return-to-page, unsafe destinations, tabs, Back/Forward...) |
| `npm run test:walkthrough` | The whole system through the real UI: student, administrator and approver workflows and scenarios A to F (needs a fresh `npm run demo`) |
| `npm run test:ui` | Every page at desktop and phone size: overflow, labels, alt text, console errors; screenshots |
| `npm run test:print` | The printable stubs and confirmation: one page, QR decodes and matches the API |

They share one small Chrome driver (`tests/support/cdp.mjs`) and need internet access (the pages load the Firebase SDK from Google's CDN).

### Security headers and print checks (local)

The Hosting emulator ignores the `headers` in `firebase.json`, so to run the site under its real Content-Security-Policy start the Auth and Firestore emulators, `npm run server`, and then `npm run serve-public` (serves `public/` on :5000 with exactly those headers) instead of the Hosting emulator.

`tests/print/print-check.mjs` renders the four printable documents (Silent Room stub, Computer Station stub, Wi-Fi voucher, confirmed reservation) in headless Chrome with print media, saves a PDF and PNG of each, counts pages, decodes the printed QR with the vendored jsQR, compares it with the API and the admin scanner, and checks that nothing but the document is visible. It is run by hand against the local stack (usage at the top of the file); it needs Chrome and is not part of `npm test`. It is a rendering check, not a camera or printer test.

## Cloud-connected development (real Firebase)

A second, separate environment runs the local website (`http://localhost:5001`) and API (`:3001`) against the real Firebase project instead of the emulators: `npm run cloud:check`, `npm run server:cloud`, `npm run serve:cloud`. It never seeds demo data and live Gmail needs its own command. Console setup, rules and index deployment, first-administrator procedure and the manual test checklist are in [docs/cloud-setup.md](docs/cloud-setup.md).

## Provisioning the first administrator

There is no public admin registration, no default admin and no admin password in the code. An operator does this once:

1. Create the administrator's account in Firebase Authentication (Emulator UI in development; the Firebase Console in production, with a verified email).
2. Run the bootstrap script:

```powershell
# development (emulators)
npm run bootstrap-admin:dev -- --email admin@example.com --name "Library Admin"

# production: set real environment variables first (NODE_ENV=production, FIREBASE_PROJECT_ID, credentials via
# Application Default Credentials), and never the *_EMULATOR_HOST variables
npm run bootstrap-admin -- --email admin@example.com --name "Library Admin" --confirm-project <project id>
```

It refuses if any administrator already exists, if the account already has a profile (existing students are never promoted; use a dedicated account), if the account is disabled, or, in production, if the email is unverified or `--confirm-project` is missing or wrong. For a real project (cloud-dev or production) an unverified address is accepted only with the explicit `--verify-email` flag, by which the operator vouches for the mailbox ([docs/cloud-setup.md](docs/cloud-setup.md), section 4).

## Orphaned student numbers

If a Firebase Auth account is deleted, its student-number lock stays. An operator releases such locks with:

```powershell
npm run release-locks:dev               # dry run: lists locks whose Auth account no longer exists
npm run release-locks:dev -- --apply    # releases them
# production: npm run release-locks -- --apply --confirm-project <project id>
```

A lock is released only when Firebase Auth answers "user not found". Any other answer keeps it. The profile is kept and marked `orphaned`, and an audit entry is written.

## Administrator recovery (lost access to the sole administrator)

There is no recovery endpoint or page. Recovery is an operator action with the Admin SDK, and it never creates an account or promotes a student.

1. **Try the normal way first.** If the administrator only forgot the password, use "Forgot password" on the login page. No recovery needed.
2. **Prepare a replacement.** Create (or pick) a dedicated Firebase Authentication account for the new administrator. In production its email must be verified. It must have **no** profile: an account that already has a student profile is refused.
3. **Run the recovery** with the operator's own credentials:

```powershell
# development (emulators)
npm run recover-admin:dev -- --old-admin lost@example.edu --new-admin spare@example.edu --reason "lost access to the administrator mailbox"

# production: real environment variables (NODE_ENV=production, FIREBASE_PROJECT_ID, credentials via Application Default
# Credentials or GOOGLE_APPLICATION_CREDENTIALS), and never the *_EMULATOR_HOST variables
npm run recover-admin -- --old-admin lost@example.edu --new-admin spare@example.edu --reason "<why>" --confirm-project <project id>
```

Safeguards: production needs `--confirm-project` equal to the project ID and a `--reason` of at least 10 characters. It proves the operator credentials work with a real privileged call before changing anything. It refuses if another administrator can still sign in (recovery is for a sole administrator), if the lost account is not an administrator, if the replacement is disabled, unverified (production) or already has a profile, or if the two emails are the same.

Effect: the replacement gets an active `admin` profile and claim. The lost administrator's profile is set to `suspended` (which the API honours immediately), the Auth account is disabled and its refresh tokens are revoked. An `admin.recovery` audit entry records the reason, the operator (OS user, plus the service account when a key file is used), the project and both accounts. The replacement's display name is its Auth display name, or its email if none is set; an administrator can be renamed later.

## Administrator tools

The dashboard is at `/nav/admin/admin.html` (Overview, Resources, System Settings). Everything goes through `/api/admin/*`, which requires a valid ID token and an **active administrator profile in Firestore** (role and status are read from the profile, not from the token). Clients have no direct Firestore access to resources, settings or audit logs.

| Route | Purpose |
|---|---|
| `GET /api/admin/summary` | Counts by resource type and status, plus effective settings |
| `GET /api/admin/resources?type=&status=` | List |
| `POST /api/admin/resources` | Create `{id, type, label, capacity?, status?}` |
| `GET` / `PATCH /api/admin/resources/:id` | Read / update `label`, `capacity`, `status` |
| `DELETE /api/admin/resources/:id` | Retire (soft delete; resources are never removed) |
| `GET` / `PATCH /api/admin/settings` | Read / partially update the six system settings |

Resource state is kept in separate dimensions: the operational `status` (active, maintenance, retired), allocation counters `{assigned, occupied, held}` that only the server's ticket and reservation transactions will maintain, and a derived `available` (never stored). A resource with any assignment, occupancy or hold cannot be moved to maintenance or retired. Retired is permanent.

## Generate Stubs

Verified students open `/nav/stubs/stubs.html`, pick **Silent Room**, **Computer Station** or **Wi-Fi Voucher**, and get a printable stub with a QR code. Discussion room reservations are separate.

**Flow (`POST /api/tickets {service}`)**: valid token, verified email (token claim), active student profile, then one Firestore transaction that: re-checks the profile; expires the student's own overdue stubs; returns the student's existing active stub for that service if there is one (**idempotent: 200, `created:false`, never a conflict**); enforces `maxActiveTicketsPerStudent` across all three services (409 `ticket-limit-reached`); picks the lowest-id `active` resource of the right type with no assignment, occupancy or hold (409 `no-resource-available`); and writes the resource counter, the ticket, the student's lock and the audit record together or not at all. A student can never choose a seat, and availability on the page is advisory: only the transaction decides.

| Collection | Purpose |
|---|---|
| `tickets/{id}` | One document per stub, kept for history: `service`, `uid`, `status`, `resourceId`/`resourceLabel`, `issuedAt`, `expiresAt`, `checkInDeadline`, `activeDeadline`, `qrRef`, `credential` (vouchers only, ciphertext). |
| `ticketLocks/{uid}` | `{ byService: { service: ticketId } }`: the student's active stubs. At most one per service and `maxActiveTicketsPerStudent` in total. |
| `resources/{id}.allocation` | `{assigned, occupied, held, ticketId}`, changed only inside ticket transactions. |

Both ticket collections are closed to every client in the Firestore rules; everything goes through `/api/tickets` (`GET /availability`, `POST /`, `GET /active`, `GET /history?limit=`, `GET /:id`, `GET /:id/print`), and identity always comes from the ID token. Another student's ticket answers 404.

**Lifecycle**: `issued -> checked_in | expired | revoked`, `checked_in -> checked_out | expired | revoked`; `checked_out`, `expired` and `revoked` are final. Issuance and expiry are implemented now; check-in, check-out and revocation exist as the internal `transitionTicket` (with resource and lock release) but have no admin screens yet. **Expiry** uses the server clock: an issued stub that is not checked in loses its seat after `noShowGraceMinutes` (0 turns that off); any stub ends at its `expiresAt` (`silentRoomTicketMinutes`, `computerTicketMinutes`, `wifiVoucherMinutes`). Overdue stubs are released lazily by any request that reads or allocates (students' reads, issuing, admin inventory), by a 60 s timer while the server runs, and by `npm run expire-tickets:dev` (schedule `npm run expire-tickets` from cron or a scheduler for production). Release is idempotent, keeps the ticket as history, and never frees a seat that has since been assigned to someone else.

**Wi-Fi vouchers are demonstrations**: a random `DEMO-XXXX-XXXX-XXXX` password from Node's `crypto`, labelled DEMO on screen and on paper. Nothing touches the university's Wi-Fi. The password is stored only as AES-256-GCM ciphertext bound to the ticket id (key `VOUCHER_ENCRYPTION_KEY`, required in production, 32 random bytes in base64; development generates a throwaway key per start). It is returned only by the owner's `GET /:id/print` while the voucher is active (so a lost response or a reprint works) and is never in the QR, audit logs or any list/detail response. The QR carries only `NUFV1:<opaque reference>`.

**Tests**: `npm test` runs two emulator passes. The ticket tests (`tests/tickets`) run on their own emulator, one file at a time, because they need exclusive control of the inventory and settings. Run just them with `npm run test:tickets`.

## Discussion room reservations

Students request a room on the Reserve Room page (`/nav/reserve/reserve.html`) and follow it in My Reservations (`/nav/reservations/reservations.html`). A request passes through an administrator-configured chain of **external approvers**, then a **final administrator**, and only then is it confirmed and given a QR. External approvers are email recipients for one step; they have no account and no role (the application still has only `student` and `admin`).

The Home page (`/nav/main/main.html`) shows only real data: each room's status for right now at the library (from the availability endpoint; it is advisory, the booking transaction decides), the student's own upcoming and pending reservations, and a plain notice that there is no announcements feature.

**Time policy**: booking times are university-local wall-clock times in `Asia/Manila` (UTC+8, no daylight saving). The server stores absolute instants plus the local date. Bookings must fall inside 08:00-20:00 local, on one day, last at most 4 hours, start in the future, and be at most `reservationAdvanceBookingDays` ahead; start and end must fall on `discussionRoomBookingIntervalMinutes` marks. A student may hold at most 3 open (pending or upcoming) reservations. The server clock is the only clock.

**Conflict prevention**: a booking is a set of at most 16 slot locks (`reservationLocks/{room}__{date}__{HHMM}`, always 15-minute slots, so any 15/30/60-minute interval works and bookings that only touch share no slot). Submitting reads all of a booking's locks and creates them in one transaction only if none is live. A lock is live until its `expiresAt`: the current step's deadline while pending, the end of the booking once confirmed. A lapsed hold therefore frees its slots by itself with no cleanup job, and a reservation only ever releases locks that still carry its own id. A room with open reservations cannot be taken out of maintenance or retired.

**Approval state machine** (`reservations/{id}`, status `pending | confirmed | rejected | cancelled | expired`):
- The approval chain is copied into the reservation at submission, so editing the chain never changes a request in flight. Chain: enabled external steps in order, then the always-present final administrator step (not configurable, not removable).
- Only the current step can act (`expectedStep`), and only its own kind of actor: the bound external approver, or an authenticated administrator for the final step. Students have no approval route. A decision closes that step's challenge in the same commit, so repeats find nothing to act on.
- Each step has a deadline (`stepHours`, default 48, never beyond the booking start). Server time decides: an overdue request can only expire, whatever is asked, and the room is released. Rejection, cancellation (student before the start, administrator before the end) and expiry all release the holds.
- Every decision writes an immutable `approvalActions` record (with an explicit `seq`), an audit entry and, where relevant, an email, all in the same transaction. A confirmation reference (`RC-...`) and QR (`NUFR1:<opaque ref>`) exist only after the final approval.

**External approver verification**: the notice email carries a link with a challenge id only (in the URL fragment); the link shows nothing and cannot approve. The page asks for a one-time code, sent only to the address the step is bound to. Codes (6 digits, 10 minutes, 5 attempts each, 5 codes and 10 wrong guesses per request, 30 s between codes) and sessions (30 minutes) are stored only as HMAC-SHA256 with `APPROVAL_SECRET`. A code works once; a decision closes the challenge. After a lock-out an administrator re-sends the request (`POST /api/admin/reservations/:id/resend`).

**Email outbox** (`emailOutbox`): messages are written in the transaction that causes them and delivered by a processor through an adapter. Delivery is **at least once**, not exactly once: a message is claimed with a lease; transient errors retry with backoff (15 s doubling, max 6 attempts); permanent errors fail at once; a worker that dies mid-send loses its lease and the message goes out again (a recipient may rarely get a duplicate). History stays on the document and one-time-code bodies are blanked once delivery ends. Development and tests use an in-memory sink (nothing leaves the machine); read it at `GET /api/dev/mail` (not mounted in production). The server drains the outbox on a timer; `npm run process-outbox[:dev]` does it once. Production needs `MAIL_TRANSPORT=smtp`, `SMTP_HOST/PORT/USER/PASS`, `MAIL_FROM`, `APP_BASE_URL` and `APPROVAL_SECRET`, **and** `MAIL_LIVE_APPROVED=yes`: live delivery never turns on by default.

| Route | Who | Purpose |
|---|---|---|
| `GET /api/reservations/config`, `/rooms`, `/availability?date=` | verified student | Rules, active rooms, taken time (advisory) |
| `POST /api/reservations`, `GET /`, `GET /:id`, `POST /:id/cancel`, `GET /:id/print` | verified student, own records only | Submit, history, progress, cancel, confirmation (confirmed only) |
| `GET /api/approvals/:id`, `POST /:id/code`, `/verify`, `/review`, `/decision` | external approver (no login) | One step: ask for a code, verify it, review, decide once |
| `GET/PUT /api/admin/approval-workflow` | admin | View/replace the external chain |
| `GET /api/admin/reservations[?status=]`, `GET /:id`, `POST /:id/decision {decision, step}`, `/cancel`, `/resend` | admin | Queue, history, final approval, cancellation, re-send |

## Ticket operations (administrators)

The admin dashboard's **Scan Codes** view scans a stub's QR code (camera, or typed code / ticket id) and offers the actions the API says are allowed. It also reads discussion room reservation confirmations (`NUFR1:` QR or an `RC-` reference): see "Operations, audit and recovery". Everything is decided by the server, from server time; the screen only shows the answer.

| Route (admin only, active admin profile) | Purpose |
|---|---|
| `POST /api/admin/tickets/resolve {reference}` | QR payload `NUFV1:<24 chars>`, the bare reference, or a ticket id. Expires the ticket first if it is overdue, then returns `{ticket, student, allowedActions, warnings}`. No uid, QR reference, credential or password is ever returned. |
| `POST /api/admin/tickets/:id/check-in {identityChecked:true}` | Physical stubs only. Needs the administrator to attest they checked the student's ID (a QR proves nothing about who holds it). |
| `POST /api/admin/tickets/:id/check-out` | Checked-in tickets only. |
| `POST /api/admin/tickets/:id/revoke {reason}` | Reason of 3 to 200 characters required. Issued, checked-in and Wi-Fi tickets. |

**Rules, enforced in one Firestore transaction each** (`transitionTicket`):
- *Server time wins.* If a ticket is overdue when anything touches it, the only outcome is expiry (`no_show` before check-in, `expired` after); the requested action is refused with 409 `no-show` / `ticket-expired`, and the expiry is committed. No cleanup job is needed for correctness.
- *Boundary:* a deadline is the first instant that is too late. Check-in works strictly before `checkInDeadline`; at that instant it is a no-show. Same for `expiresAt`. A grace of 0 turns no-show off; Wi-Fi vouchers never have one.
- *Check-in* needs: physical ticket, status `issued`, active student, and the resource still pointing at this ticket (`allocation.ticketId`). It moves the seat assigned to occupied, keeps the lock, and keeps the original `expiresAt`.
- *Release is guarded by the ticket id*: only the ticket that holds a resource can release it, so a stale or replayed QR cannot free or occupy a seat that now belongs to someone else.
- *Repeats are quiet*: repeating check-in, check-out or the same revocation returns 200 `changed:false`, with no second audit entry and no counter change. Any other move out of a final state is 409 `invalid-transition`.
- Every action writes an audit entry (actor, reason, identity attestation) and keeps the ticket as history (`endedBy`, `endReason`, `revokeReason`).

**Scanner**: jsQR 1.4.0 (vendored in `public/vendor/jsqr`, Apache-2.0) decodes camera frames in the browser; it works on `https` pages and on `localhost`. Camera permission, missing camera and busy-camera cases give plain messages and manual entry always works. The camera is released when you leave the view, hide the tab, close the page, or cancel while the permission prompt is open.

## Operations, audit and recovery (administrators)

All routes are under `/api/admin`, behind the same administrator gate, and answer `Cache-Control: no-store`.

| Route | Purpose |
|---|---|
| `POST /api/admin/qr/resolve {reference}` | One scanner for both formats: `NUFV1:` stubs (as before) and `NUFR1:` / `RC-` reservations. Returns `{kind: 'ticket' | 'reservation', ...}`. A bare 24-character reference is a stub's. |
| `GET /api/admin/ops/approvals` | Pending approval steps (who, deadline, challenge state, review-email state, what needs attention) and recently expired requests. Sweeps overdue requests first. |
| `GET /api/admin/ops/emails?status=failed\|queued\|sending\|sent` | Counts per state and one bounded page. Message bodies are never returned. |
| `POST /api/admin/ops/emails/:id/requeue` | Sends a **failed** message again (fresh attempts, audited). Refused when its one-time code was discarded, or its review link is no longer the live one. |
| `GET /api/admin/ops/diagnostics` | Read-only consistency check (same code as `npm run reconcile`, dry run). |
| `GET /api/admin/audit?limit=&action=&target=&before=` | Audit log, newest first, at most 100 per page, one filter at a time, continued with `before=<last id>`. Secret-looking keys are redacted on the way out. |

**Reservation scan** (read-only): shows the student, room, approved date and time, status, and whether the booking is valid *right now* (confirmed and inside its approved time on the server clock). Cancelled, rejected, expired and unknown codes are reported as such. It never returns approver addresses, challenge ids, QR references or workflow internals. There are no attendance transitions for reservations: that needs an approved policy first.

**Recovery never decides for anyone.** Nothing skips an approval step, reopens an expired request or resets a workflow. A locked or unreachable approver is handled with the existing "send the request again" (new link, old one dies, audited). A failed email is sent again as the same message.

**Consistency check and repairs** (`npm run reconcile:dev`, operator only, never over HTTP): reports seats held by stubs that are not active, active stubs whose seat does not point back, room holds nobody owns, active reservations missing part of their hold, and open approval links that are not current. `-- --apply` repairs only the first, third and fifth of those (each re-checked inside its own transaction and audited as `reconcile.*`), and deletes room holds that ended over a day ago and expired rate-limit counters. Production needs `--confirm-project <id>`. Anything that needs a human decision is reported, not repaired.

**Public approval throttling** (`server/rateLimit.js`): per client address, a per-process counter on every `/api/approvals` request, and a Firestore-backed counter (`rateLimits`, address stored only as a keyed hash) on code and verify requests, so that one holds across instances and restarts. The per-process one is **only effective within one Express instance**. Behind a reverse proxy set `TRUST_PROXY_HOPS` to the number of proxies, otherwise every visitor shares the proxy's address. The per-request limits (5 codes, 5 attempts per code, 10 wrong guesses) remain the real guard against guessing.

`GET /api/health` is a liveness probe (no Firebase call). The server drains in-flight requests on SIGTERM.

See `docs/production-readiness.md` for everything needed to take this live.

## Sign-in navigation

There is one rule for where a person goes, in `public/js/guard.js` (protected pages) and `public/login page/login.js` (the login page):

| Situation | Result |
|---|---|
| Student signs in, nothing remembered | Student Home |
| Administrator signs in | Administrator dashboard |
| Signed-out visitor opens a protected page | Login with `?next=<that page>`; after signing in, back to that page **if it is a known page for their role**, else their home |
| Another role's page, another site, any query string, odd encodings, any unknown page in `next` | Ignored: their own home (`safeNext` in `public/js/session.js`; the allowed pages are `RETURN_PAGES`) |
| Signed in elsewhere out (other tab, expired session) | Login, remembering this page |
| Explicit **Log out** | Login, nothing remembered |
| Suspended or profile-less account | Stays on Login with a message and holds no session |
| Wrong role's page while signed in | Their own home |
| Already signed in and opens the login page | Their destination (or home) |

The login page is replaced, not stacked, in the history, so Back does not bounce through it, and a page restored from the back/forward cache is checked again. Before this change there was **no** return-to-page behavior (every sign-in went to the role's home); it was added deliberately. `tests/auth/nav-check.mjs` runs all of this in real Chrome against the local stack (usage at the top of the file); `tests/unit/session.test.js` covers the destination rules.

## Email verification

Registration and sign-in never require a verified email. Library pages (`data-require-verified`) send an unverified student to `/nav/verify/verify.html`, where they can resend the email (60 s cooldown, rate-limit errors handled), refresh their status or log out. The server-side source of truth is the `email_verified` claim in the ID token (`requireVerifiedEmail`, demonstrated by `GET /api/students/access`); the page forces a token refresh after verifying. Administrators are not subject to the requirement.

In the emulator no email is delivered. Open the verification link from `http://127.0.0.1:9099/emulator/v1/projects/demo-nufv/oobCodes` (field `oobLink`), or from the Emulator UI Authentication tab, then choose "I have verified my email".
