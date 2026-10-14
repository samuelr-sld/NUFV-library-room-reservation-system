# Cloud-connected development (real Firebase, Spark plan)

Two isolated environments. Pick by command and by address; they cannot be mixed by accident.

| | **Local demo** | **Cloud-connected development** |
|---|---|---|
| Start | `npm run demo` | `npm run server:cloud` + `npm run serve:cloud` |
| Website | `http://localhost:5000` | `http://localhost:5001` (exactly this; not `127.0.0.1`) |
| API | `http://localhost:3000` (all interfaces) | `http://127.0.0.1:3001` (this machine only) |
| Auth / Firestore | emulators of `demo-nufv` | **real** project `lrc-room-reservation` |
| Application email | in-memory sink | sink; **Gmail only** with `npm run server:cloud:mail` |
| Seeded data | demo accounts, inventory, approvers | **none, ever** |
| Config file | built into `server/scripts/demo.js` | `server/.env.cloud` (git-ignored) |
| `NODE_ENV` | `development` | `cloud-dev` |

The website decides by port: only `localhost:5001` gets the real project's web config (`PROD_CONFIG` in `public/js/firebase-config.js`); every other local address is wired to the emulators. The browser keeps the two sign-in sessions apart because they are different origins.

## What the server refuses (fail closed)

`NODE_ENV=cloud-dev` exits at startup, naming the setting (never a value), if:
`FIREBASE_AUTH_EMULATOR_HOST`, `FIRESTORE_EMULATOR_HOST` or `FIREBASE_EMULATOR_HUB` is set; the project is `demo-*`; `FIREBASE_PROJECT_ID` differs from the project in `public/js/firebase-config.js` (same check in production); `GCLOUD_PROJECT`/`GOOGLE_CLOUD_PROJECT` disagree; `GOOGLE_APPLICATION_CREDENTIALS` is missing, unreadable, not a service-account key, or belongs to another project; `VOUCHER_ENCRYPTION_KEY` or `APPROVAL_SECRET` is missing; or SMTP is half-configured / lacks `MAIL_LIVE_APPROVED=yes`.
The demo, seed and reset commands refuse anything but `development`/`test` on a `demo-*` project with loopback emulators. There is no automatic fallback in either direction.

## 1. Firebase Console setup (project `lrc-room-reservation`, Spark plan)

1. **Project settings > General.** Confirm the Project ID. Under *Your apps > Web app*, confirm the config equals `PROD_CONFIG` in `public/js/firebase-config.js` (`apiKey`, `authDomain`, `projectId`, `appId`). It is public client configuration; it protects nothing. Security is the Firestore rules plus the API.
2. **Build > Authentication > Get started > Sign-in method:** enable **Email/Password** only (not "Email link"). **Settings > Authorized domains:** `localhost` must be listed (it is by default). If the browser API key is restricted in Google Cloud > Credentials, allow the referrer `http://localhost:5001/*`.
3. **Build > Firestore Database > Create database.** Choose **production mode (locked)**, never test mode, and a location (permanent). Do this before anything else touches data.
4. **Project settings > Service accounts > Generate new private key.** Save the JSON **outside the repository** (for example `C:\Users\<you>\secrets\`). This is the only privileged credential; it lives on the server side only. Delete the key in the Console when testing ends.
5. Leave Hosting, Functions, Storage and billing untouched. Stay on Spark.
6. Gmail (optional, step 11 of the checklist): follow `docs/gmail-smtp-setup.md`, but put the six settings in `server/.env.cloud.mail`, not `.env.local`.

## 2. Configuration

```powershell
copy server\.env.cloud.example server\.env.cloud      # then edit
# generate the two keys (each is 32 random bytes, base64):
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
npm run cloud:check                                    # validates, contacts nothing
npm run cloud:verify -- --confirm-project lrc-room-reservation   # FIRST live contact, read-only (see below)
```

`cloud:verify` is the gate before `server:cloud`. It requires the typed project id, checks that the configured project, the Admin SDK app and Firestore all name the same project, then makes three reads: one Authentication user, the Firestore collection names, and "does an administrator exist". It writes nothing and prints only names and yes/no (no emails or ids). It needs the Firestore database (section 1, step 3) to exist; "failed: …" names the service and error code that did not answer. Run it only after you approve the first live contact.

| Variable | Where | Meaning |
|---|---|---|
| `NODE_ENV=cloud-dev` | `.env.cloud` | selects this environment |
| `FIREBASE_PROJECT_ID` | `.env.cloud` | must equal the website's project |
| `GOOGLE_APPLICATION_CREDENTIALS` | `.env.cloud` | path to the service-account key (forward slashes) |
| `VOUCHER_ENCRYPTION_KEY`, `APPROVAL_SECRET` | `.env.cloud` | required: real data must survive restarts |
| `PORT` | optional | default 3001; the website expects 3001 |
| `OUTBOX_POLL_SECONDS`, `SWEEP_POLL_SECONDS` | optional | background polling, see section 6. cloud-dev defaults 60 and 300 (elsewhere 10 and 60); limits 5–3600 and 30–3600 |
| `MAIL_TRANSPORT=smtp`, `MAIL_LIVE_APPROVED=yes`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | `.env.cloud.mail` only | live Gmail; every one is required |

Never set the `*_EMULATOR_HOST` variables in your shell for cloud work; the server refuses to start if they exist. Firebase **Authentication** emails (verify email, reset password) are sent by Firebase itself, not Gmail, and are real as soon as the website is in cloud mode.

## 3. Deploy the security rules and indexes (not done automatically)

Do this **before** registering anyone. Indexes take minutes to build; wait for *Enabled* in Console > Firestore > Indexes (the emulator never enforces indexes, so this is the first real test of them).

```powershell
firebase login
firebase deploy --only firestore:rules,firestore:indexes --project lrc-room-reservation
```

Always pass `--only firestore:...` and `--project`. A bare `firebase deploy` would also publish Hosting; `.firebaserc` defaults to `demo-nufv`, so a bare command cannot hit the real project by accident.

* **Rules** deny everything except: a signed-in user reading their own `users/{uid}`. Proven by `tests/rules` (emulator): clients cannot write `users` (so no role change), and cannot read or write `tickets`, `ticketLocks`, `reservations`, `reservationLocks`, `approvalChallenges`, `approvalActions`, `approvalWorkflows`, `emailOutbox`, `auditLogs`, `studentNumbers`, `resources`, `settings`, `rateLimits`. The Admin SDK bypasses rules, so the API is unaffected.
* **Indexes** (`firestore.indexes.json`, 12 composite). Reviewed against every query in `server/`: each ordered or range query is covered (tickets by uid/issuedAt and resourceId/status; reservations by uid/startsAt, status/startsAt asc and desc, status/endedAt, status/endsAt; emailOutbox by status with nextAttemptAt, leaseUntil or createdAt; auditLogs by action/at and targetId/at). All other queries are equality-only or single-field. The audit view refuses action+target together, so no index for that pair is needed. If a query still fails live, the error carries a link that creates the missing index.

## 4. Create the first cloud administrator

No admin password exists in the code and student registration can never produce an admin. The script promotes an *existing* Authentication account that has *no profile*.

**Why an extra step exists.** An account added in the Console is never email-verified, the Console has no button to verify it, and an account without a profile cannot sign in to the app (it would be refused as `no-profile`), so the app's own verification page is unreachable for it. Do not assume a password reset verifies the address; that is not relied on anywhere. The operator instead vouches for the mailbox with an explicit flag, and the Admin SDK records it.

1. Decide the administrator mailbox: one **you control**, dedicated to this role (not a student account).
2. Console > Authentication > Users > **Add user**: that address and a long random throwaway password you discard (the real password is set in step 7).
3. `npm run cloud:check`, then `npm run cloud:verify -- --confirm-project lrc-room-reservation` (read-only). Its last line `An administrator exists` must be `false`.
4. Dry look first: run the command below **without** `--verify-email`. It must refuse with "not verified … repeat with --verify-email", having changed nothing.
5. ```powershell
   npm run bootstrap-admin:cloud -- --email <admin address> --name "<full name>" --confirm-project lrc-room-reservation --verify-email
   ```
   Refused (nothing changed) unless **all** hold: exact `--confirm-project`; the account exists, is enabled and has no profile; no administrator exists yet; and `--verify-email` is a real flag (it is the only way an unverified address is accepted). Only after the profile, the audit row and the `admin` claim are written does it set `emailVerified` through the Admin SDK. The audit entry (`admin.bootstrap`) records the operator, the project and `emailVerifiedByOperator: true`.
6. Console > Authentication: confirm the user shows as verified; Firestore `users/{uid}` has `role: admin`; `auditLogs` has the `admin.bootstrap` row.
7. Run `npm run serve:cloud`, open `http://localhost:5001/forgot_pass/forgot.html`, request a reset for the admin address and set your own password. This also proves the mailbox really receives Firebase's emails.
8. Create a **separate** student test account by the normal registration page. Do not reuse the administrator.

If step 5 fails after the profile is written but before the address is marked verified (a network drop), re-running is refused because an administrator now exists. The administrator still works (the app requires verification from students only); the Authentication entry just stays unverified. Do not hand-edit Firestore to retry.

`recover-admin` (lost-administrator replacement) has the same "replacement must be verified" rule and has **no** such flag yet; for a cloud recovery, verify the replacement's mailbox first or ask for the flag to be added.

## 5. Manual cloud test checklist

Use only accounts and resources made for this test (ids like `test-silent-01`, `test-room-a`). Do not run concurrency/race scripts or `npm test` variants against this project. Order: `cloud:check`, `cloud:verify`, deploy rules and indexes (section 3), bootstrap the administrator (section 4). Then start `npm run server:cloud` (sink; add Gmail only at step 11, section 7) and `npm run serve:cloud`, open `http://localhost:5001/login%20page/login.html`. Server console shows `*** REAL Firebase project ... ***`.

| # | Step | Expect | Where to confirm |
|---|---|---|---|
| 0 | As admin, Resources: add `test-silent-01` (silent seat), `test-pc-01`, `test-room-a` (room, capacity 4); Workflow: one approver = a mailbox you own | created | Console > Firestore `resources`, `approvalWorkflows/current` |
| 1 | Register a student (a mailbox you own, student number `TEST-0001`) | redirected to login with "verification email sent" | |
| 2 | | user exists, email unverified | Console > Authentication > Users |
| 3 | | `users/{uid}` role `student`, `studentNumbers/TEST-0001` | Console > Firestore |
| 4 | Open the verification email (sent by Firebase), click it; on the verify page choose "I have verified my email" | taken to dashboard | Authentication shows verified |
| 5 | Sign out, sign in, reload the page | session restored | |
| 6 | Student: generate a Silent Room stub | stub with QR | |
| 7 | | `tickets/*` active; `resources/test-silent-01.allocation.assigned = 1`; `ticketLocks/{uid}` | Console > Firestore |
| 8 | Admin (other browser profile): scan the stub QR (or paste its reference) | stub details shown | |
| 9 | Check in, then check out | ticket `checked_in`, then ended; `allocation` back to 0 | Firestore + Audit Log screen |
| 10 | Student: submit a discussion-room reservation for a future slot | status `pending` | `reservations/*`, `reservationLocks/*` |
| 11 | Rehearse with the sink first (`http://localhost:3001/api/dev/mail/view`); then follow section 7 to repeat with Gmail | approver mailbox receives the notice | the approver's inbox; Admin > Operations shows `sent` |
| 12 | Approver opens the link **in a browser on this computer**, requests a code, enters it | code accepted | `approvalChallenges`, `approvalActions` |
| 13 | Admin gives final approval | status `confirmed` | |
| 14 | Student opens the reservation, QR verifies in the admin scanner | matches | |
| 15 | Stop and restart `npm run server:cloud`; sign in again | reservation, stub history and accounts all still present | |

Afterwards, clean up with section 8. Do not just delete the test student from Authentication.

## 6. Limits, cost and background polling (Spark)

* Firestore free quota: 50,000 reads, 20,000 writes per day, 1 GiB. The Console shows usage; on Spark an exhausted quota makes requests fail rather than bill.
* A running server polls Firestore on two timers; each pass costs at least one read per query even when nothing is due:

  | Timer | Queries per pass | Local default | cloud-dev default | Reads/day at cloud-dev default |
  |---|---|---|---|---|
  | email outbox (`OUTBOX_POLL_SECONDS`) | 2 | 10 s | 60 s | about 2,900 |
  | ticket and reservation sweeps (`SWEEP_POLL_SECONDS`) | 2 | 60 s | 300 s | about 600 |

  That is roughly 3,500 reads a day if the server is left running (about 20,000 at the local defaults). The bounds are 5–3600 s and 30–3600 s; there is deliberately no way to turn a timer off.
* What the slower timers change, and what they do not. **Email delivery:** mail queued by a request (reservation submitted, approval acted on, admin resend) is delivered immediately by that request; the outbox timer only picks up retries (their backoff starts at 15 s, so a retry may wait up to one poll longer), messages whose delivery was interrupted (lease expiry), and mail queued by a sweep. **Ticket expiry:** every read or allocation expires what it touches, so a seat is never handed out while an overdue stub holds it; the sweep only tidies up. **Reservations:** a student's own reads and every action expire their overdue requests, but a *different* student booking the same slot does not; a room slot held by a request whose approval deadline has passed is released by the sweep, so it can look "taken" for up to `SWEEP_POLL_SECONDS` longer, and the "request expired" email is queued by the sweep (delivered at the next outbox poll). Nothing is ever double-booked or lost. For a demonstration that waits on a deadline, lower `SWEEP_POLL_SECONDS`, or run `npm run expire-tickets` / `process-outbox` yourself.
* **Stop the server when you are not testing.**
* Cloud mode is not deployed anywhere: both the website and the API run only on this machine. See section 7 for what that means for approval links.
* Firebase's built-in verification link opens a Firebase-hosted page; afterwards return to the app tab. Firebase rate-limits repeated verification emails per address.

## 7. Testing Gmail notifications safely on one machine

**The approval-link limitation.** Every approval email contains a link built from `APP_BASE_URL`, which in cloud-dev is `http://localhost:5001/approve/approve.html#<id>`. `localhost` means "the computer opening the link", so the link works only in a browser on **this** computer while `npm run serve:cloud` and `npm run server:cloud:mail` are running. Opened on a phone, another computer or after the servers are stopped, it fails to load. That is expected, not a bug. Do **not** work around it with a tunnel or by editing `APP_BASE_URL` alone: that publishes the site (out of scope), is blocked by the API's CORS allowlist, and `127.0.0.1` binding would not accept it anyway. The only supported LAN setup is the opt-in test at the end of this section.

**Procedure.**
1. **Rehearse with the sink, no email at all.** `npm run server:cloud`, run the whole approval chain (checklist 10–13) and read the notice and the one-time code at `http://localhost:3001/api/dev/mail/view`. This proves the logic against the real project before any message leaves the machine.
2. **Use only mailboxes you own.** Live mode mails whoever the workflow names. Make the approver (Admin > Workflow) and the test student addresses you own: a second inbox, or a Gmail plus-address of yours (`you+approver@gmail.com`; it delivers to your inbox and Firebase Authentication treats it as a distinct address). Never type a real dean, adviser or classmate. Check Admin > Workflow and Admin > Operations (no queued items for anyone else) before switching.
3. **Prove the SMTP login once:** put the settings of `docs/gmail-smtp-setup.md` in `server/.env.cloud.mail`, then `npm run mail:test:cloud -- --to <your mailbox>`. One message, no retry.
4. **Restart with Gmail on purpose:** stop the sink server, `npm run cloud:check` (it must print `Application mail LIVE through smtp.gmail.com as …`), then `npm run server:cloud:mail`. The sink viewer disappears in this mode, by design.
5. Submit one reservation, and open the approver's email **in a browser on this computer** (Gmail in the web browser works; the mail app on a phone does not for the link). Request the code on the approval page; it arrives as a second email. Finish the chain, then stop the server.
6. Expect a handful of messages against Gmail's roughly 500 a day. Revoke the App Password when done (`docs/gmail-smtp-setup.md`).

**Exception: same-Wi-Fi approver test (opt-in, testing only).** To let an approver vote from their own phone, put the laptop, the approver and anyone else involved on **one network you control** (your phone's hotspot or home Wi-Fi, never campus or public Wi-Fi). Everything is plain http, and the API (real data) becomes reachable by every device on that network.
1. `ipconfig`: note this laptop's IPv4 address on the hotspot adapter (e.g. `192.168.43.10`; iPhone hotspots use `172.20.10.x`).
2. Create `server/.env.cloud.lan` (git-ignored) with `LISTEN_LAN=yes`, `APP_BASE_URL=http://<that IP>:5001` and `CORS_ORIGINS=http://localhost:5001,http://<that IP>:5001`.
3. Start `npm run serve:cloud:lan` and `npm run server:cloud:mail:lan`. On first start Windows asks whether Node may accept connections: allow **Private networks** only.
4. Students and the administrator keep using `http://localhost:5001` on the laptop. Only the approval page works at the LAN address (sign-in pages refuse it on purpose).
5. If the laptop's IP changes, update the file, restart, and use Admin > Resend for links already emailed. Afterwards stop both servers and delete `server/.env.cloud.lan`; the plain commands are local-only again.

Firebase Authentication emails (verify, reset) are sent by Firebase regardless of this section and are never affected by the sink/Gmail choice.

## 8. Cleaning up test data (read before deleting any account)

A student's records are linked: the Auth account, `users/{uid}`, the `studentNumbers/{number}` lock that keeps the number unique, `ticketLocks`/`tickets` (a held seat), `reservations` and `reservationLocks` (a held room slot), plus audit and outbox history. **Deleting only the Auth user leaves all the rest**: the student number stays locked and cannot be registered again, a seat or room slot can stay held until its deadline, and a profile points at an account that no longer exists.

1. **Preferred: do not delete; disable.** Console > Authentication > Users > Disable. The API refuses a disabled account immediately and every record stays consistent. The student number stays reserved, which is correct for a disabled account.
2. **When the account must go (for example to reuse a student number in a repeat test):**
   1. Release anything it holds: Admin > Tickets: *revoke* its active stub; Admin > Reservations: *cancel* its pending or confirmed reservations.
   2. Delete the user in the Console (Authentication > Users).
   3. `npm run release-locks:cloud` is a **dry run**; it lists student numbers whose owner no longer exists in Authentication, and changes nothing. A lock is released only when Authentication answers "user not found" for its owner.
   4. `npm run release-locks:cloud -- --apply --confirm-project lrc-room-reservation` releases those locks, marks each profile `orphaned` and writes an audit row (`studentNumber.release`). It deletes only the lock.
   5. `npm run reconcile:cloud` (dry run, read-only) reports seats or room slots still held by nothing; apply repairs with `-- --apply --confirm-project lrc-room-reservation` only after reading the report.
3. **What deliberately remains:** the orphaned profile, tickets, reservations, audit entries and outbox records. They are history; no script or screen hard-deletes them, and this guide adds none. Resources are *retired* in the admin screen, never deleted.
4. **If the whole project is disposable** and you want it empty, do it by hand in the Console (Firestore: delete each collection; Authentication: select all users, delete), and do both so no lock or profile is left pointing at nothing. That is a deliberate manual step; nothing here automates it.
5. **Credentials last:** delete the service-account key in the Console (Project settings > Service accounts), delete the local key file and `server/.env.cloud*`, revoke the Gmail App Password.
