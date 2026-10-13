# Functional test matrix (Stage 10)

How to read this: every row says what was checked, what was expected, what actually happened, and where the proof is. Results come from three different kinds of evidence, and the labels matter:

| Label | Meaning |
|---|---|
| **Automated** | `npm test`: Node's test runner, most of it against the real Authentication and Firestore **emulators**. Repeatable, no human involved. |
| **Browser-scripted** | A script drives the **real UI** in headless Chrome against the demonstration environment (`npm run test:walkthrough`, `test:ui`, `test:browser`, `test:print`) and records the observed result and a screenshot. Repeatable by anyone with Chrome. |
| **Observed by hand** | Looked at personally in headed Chrome through the browser extension. Not repeatable by script; described, with the limits stated. |
| **Not verified** | Not exercised: it needs hardware, the internet-facing deployment or real services. Listed in section 7. |

Nothing here touched a real Firebase project or sent a real email.

## 1. Automated suites (`npm test`: 427 tests, 0 failures)

`npm test` runs three groups: main (225), tickets (88), reservations (114).

| Area | What is proved | Files (tests) |
|---|---|---|
| Authentication and sessions | Sign-in, restoration, role redirects, suspended and profile-less accounts, return-to-page rules (39 unsafe destinations), email verification and password-reset helpers, API client error handling | `tests/unit/session.test.js` (19), `verification` (11), `password-reset` (4), `api` (11), `firebase-config` (3) |
| Registration and profiles | Profile creation, student-number uniqueness (case-insensitive), neutral number policy, idempotent retry, rollback | `tests/server/students.test.js` (20), `email-verification` (7) |
| Security rules and gating | Default-deny Firestore rules, own-profile read only; every admin, ticket and reservation path refuses anonymous callers, students and suspended administrators, including routes that do not exist yet | `tests/rules/*` (11), `tests/server/http.test.js` (12), `tests/reservations/scan.test.js` (8) |
| Stubs (Silent Room, Computer Station, Wi-Fi) | Issuance limits, resource allocation, check-in and check-out, no-show and expiry boundaries, revocation, voucher encryption, ownership, concurrency | `tests/tickets/*` (88), `tests/unit/voucher.test.js` (7) |
| QR codes | Both payloads (`NUFV1`, `NUFR1`, `RC-` reference) decode and resolve; unsafe and malformed references refused; scanner never leaks secrets | `tests/unit/qr.test.js` (10), `tests/reservations/scan.test.js` (8) |
| Discussion room reservations | Booking rules, slot locks, concurrent submissions (exactly one wins), cancellation, expiry races, per-student submission limit | `tests/reservations/booking.test.js` (20), `races` (9), `ratelimit` (8), `tests/unit/reservation-rules.test.js` (14) |
| External approval | Sequential steps, one-time codes (single use, limits, lock-out), sessions, replay, deadlines, concurrent decisions, restart behaviour | `tests/reservations/approvals.test.js` (33) |
| Email outbox and recovery | At-least-once delivery, retries, failed-message recovery that never skips a step, local-time wording | `tests/reservations/outbox.test.js` (12), `ops` (11), `tests/unit/mail.test.js` (8) |
| Administrator functions | Inventory, settings, audit viewer (redaction, pagination, the typed reason), approval queue, diagnostics, reconciliation (dry run by default, audited, never releases an active seat) | `tests/server/admin.test.js` (27), `tests/reservations/ops.test.js`, `reconcile` (9), `tests/unit/settings.test.js` (5), `tests/server/lifecycle.test.js` (6), `recovery` (10), `bootstrap` (9) |
| Configuration and hardening | Startup refuses unsafe configuration; CSP and headers; pages obey the CSP; CORS; rate limits | `tests/server/config.test.js` (7), `tests/unit/security.test.js` (5), `rate-limit` (3), `tests/hosting/hosting.test.js` (3), `public-paths` (2) |
| Page structure and UI rules | Same navigation everywhere, no dead links or invented content, labels point at their controls, inline notices instead of alert pop-ups, phone layouts scroll as a whole | `tests/unit/navigation.test.js` (11) |
| Demonstration environment | Seed is complete and repeatable; seeded accounts work; refuses anything but local demo emulators; mail viewer | `tests/reservations/demo.test.js` (4) |

## 2. Browser walkthrough (`npm run test:walkthrough`: 32 of 32 steps, Browser-scripted)

Real UI, headless Chrome, a fresh `npm run demo`. Each step records expected versus observed and a screenshot in `docs/evidence/`. The same data is in `docs/evidence/walkthrough-results.json`.

| ID | Area | Test case | Expected | Actual (observed) | Result | Evidence |
|---|---|---|---|---|---|---|
| ST-01 | Student | Registration form validates, then creates the account | An empty or inconsistent form goes nowhere; a valid one tells the student to verify email and returns to Login | empty submit blocked by the browser; mismatched passwords flagged (4 field(s)); then the corrected form: Login now says "Account created. Check your email to verify your address, then log in." | PASS | [evidence/ST-01.jpg](evidence/ST-01.jpg) |
| ST-02 | Student | Email verification | An unverified account is held on the verification page; after the emailed link is opened, "I have verified" lets the student in | held on the verification page ("not verified yet"); after the link was opened, redirected to Student Home | PASS | [evidence/ST-02.jpg](evidence/ST-02.jpg) |
| ST-03 | Student | Student Home shows real data only | Three demo rooms with status for now, no upcoming reservations, an honest announcements notice, the student number | rooms: Discussion Room A = Free now; Discussion Room B = Free now; Discussion Room C = Free now; "You have no upcoming reservations."; Student no. DEMO-1001 | PASS | [evidence/ST-03.jpg](evidence/ST-03.jpg) |
| ST-04 | Student | Password recovery | The reset page gives the same answer for any address; the emailed link sets a new password that then works, the old one does not | same message for a real and an unknown address ("If an account exists for that email, a p..."); reset link worked once; old password refused; new password signs in | PASS | [evidence/ST-04.jpg](evidence/ST-04.jpg) |
| ST-05 | Student | Sign-in errors and denied accounts | Wrong password and unknown user look identical; the suspended and the unverified accounts are handled | "Incorrect email or password." (both wrong password and unknown user); suspended: "This account is not active. Please contact the library." | PASS |  |
| A-01 | Scenario A | Nora generates a Silent Room stub | A stub with a seat, a stub id and a QR code; it appears under Active stubs and in History | Silent Seat 1, SR-M464KN87Z4, QR decodes to NUFV1:tuY-EqIhnKuOBNHoz3gByg4u; 1 active, 1 in history | PASS | [evidence/A-01.jpg](evidence/A-01.jpg) |
| A-02 | Scenario A | Administrator scans the QR payload | The scanner shows the student, the seat and "ISSUED" | ISSUED — Issued. Waiting for the student to check in.; Ticket ID SR-M464KN87Z4 Service Silent Room Student Nora Villanueva (DEMO-1001) Assignment Silent Seat 1 Issued Oct 13,  | PASS | [evidence/A-02.jpg](evidence/A-02.jpg) |
| A-03 | Scenario A | Check-in needs the identity confirmation | The Check in button stays disabled until the ID box is ticked; then the student is checked in | button disabled until ticked; then "Checked in." and banner CHECKED IN | PASS | [evidence/A-03.jpg](evidence/A-03.jpg) |
| A-04 | Scenario A | Check-out frees the seat | The stub becomes "CHECKED OUT"; the student sees it in History; the seat is free again | banner CHECKED OUT; student History shows checked out, Active empty; Silent Room card: "Silent Room A quiet study seat, assigned to you automatically. 3 of 3 free" | PASS | [evidence/A-04.jpg](evidence/A-04.jpg) |
| B-01 | Scenario B | Ana generates a Computer Station stub | A stub with a computer, id CS-... | Computer 1, CS-7810CPKHKB | PASS | [evidence/B-01.jpg](evidence/B-01.jpg) |
| B-02 | Scenario B | Administrator revokes it with a reason | Revoking asks for a reason; the stub becomes REVOKED; the student loses it | banner: REVOKED — Revoked: Demonstration: wrong student at the desk.; the student's Active list is empty and History shows revoked | PASS | [evidence/B-02.jpg](evidence/B-02.jpg) |
| C-01 | Scenario C | Ben generates a demo Wi-Fi voucher and retrieves its password | The voucher shows a clearly-marked demo password, the same one every time it is opened | password DEMO-L4U2-Z4PM-RQL5 (demo banner shown, same password on reopening); QR NUFV1:7V0jg6sm2_2t0edr_xve9a5X | PASS | [evidence/C-01.jpg](evidence/C-01.jpg) |
| AD-01 | Administrator | Dashboard overview | Cards for the three resource types and the current settings | 3 resource cards, 9 settings facts; 3resources silent seats | PASS | [evidence/AD-01.jpg](evidence/AD-01.jpg) |
| AD-02 | Administrator | Resource creation | A new computer station is added through the form and appears in the inventory | 8 -> 9 resources; "Resource added." | PASS | [evidence/AD-02.jpg](evidence/AD-02.jpg) |
| AD-03 | Administrator | Resource validation | A duplicate identifier and an empty form are refused with a message | empty: "Identifier and label are required."; duplicate: "A resource with this id already exists." | PASS | [evidence/AD-03.jpg](evidence/AD-03.jpg) |
| AD-04 | Administrator | Maintenance and two-step retire | Two stations go into maintenance (a status change); a throwaway seat is retired only on the second click | pc-02 and pc-03 maintenance, temp-01 retired after a second "Confirm retire" click (10 rows) | PASS | [evidence/AD-04.jpg](evidence/AD-04.jpg) |
| AD-05 | Administrator | System settings | A setting is changed, versioned and restored | 180 -> 200 ("Settings saved (version 1).") -> restored; 5 minutes refused: "wifiVoucherMinutes must be between 15 and 1440." | PASS | [evidence/AD-05.jpg](evidence/AD-05.jpg) |
| AD-06 | Administrator | Scanner rejects what is not a library code | Garbage gets a clear message; an unknown but well-formed code is "no match" | "That is not a library code. Scan the QR code on a stub or a ..."; unknown stub: "No stub matches this code."; unknown reservation: "No reservation matches this code." | PASS | [evidence/AD-06.jpg](evidence/AD-06.jpg) |
| D-01 | Scenario D | Carla submits a reservation (form validation first) | An incomplete form is refused in place; a complete one is submitted and waits for the Dean | empty form: blocked by the browser's required-field check (form invalid); no request sent; then: "Request submitted (RS-Y0XMJBXNRC). It is waiting for: College Dean. Follow its progress in My Reservations" | PASS | [evidence/D-01.jpg](evidence/D-01.jpg) |
| D-02 | Scenario D | The Dean approves through the emailed link | Link -> request a code -> code from the email -> review shows the student and room -> approve | review showed: Requested by Carla Lim (DEMO-0003) Room Discussion Room A Date 2026-10-14 Time 09:00 – 10:00 (Asia/Manila) Participants 2: Carla L; result: "Approved" | PASS | [evidence/D-02.jpg](evidence/D-02.jpg) |
| D-03 | Scenario D | The Library Adviser approves next, only after the Dean | The second approver is notified only now; approving moves it to the final administrator | student's progress: College Dean: approved \| Library Adviser: approved \| Final administrator approval: waiting for a decision | PASS | [evidence/D-03.jpg](evidence/D-03.jpg) |
| D-04 | Scenario D | Administrator gives the final approval | The request appears as "Needs your decision"; approving confirms the booking | "Approved. The booking is confirmed." | PASS | [evidence/D-04.jpg](evidence/D-04.jpg) |
| D-05 | Scenario D | The student gets a confirmation with a QR; the administrator verifies it | The confirmation shows reference RC-..., its QR decodes to NUFR1:..., and scanning it shows a confirmed booking that is not valid yet | confirmation RC-1RJE4636TW; QR NUFR1:2wKiTZ9mNjF8D1_NQdkw2q4i; scanner: CONFIRMED — Not valid right now. The booking has not started yet. | PASS | [evidence/D-05.jpg](evidence/D-05.jpg) |
| D-06 | Scenario D | A rejection reaches the student with its reason | The Dean rejects with a comment; the student sees Rejected and the reason; the room is released | Dean: "Rejected"; student sees: "Reason given: Room reserved for a faculty meeting" | PASS | [evidence/D-06.jpg](evidence/D-06.jpg) |
| E-01 | Scenario E | Two students race for the last free computer station | Exactly one gets a stub; the other is told none is free | winner: eli; the other saw: "No computer station seat is free right now. Please try again later." | PASS | [evidence/E-01.jpg](evidence/E-01.jpg) |
| E-02 | Scenario E | Two students submit the same room and time at the same moment | Exactly one request is accepted; the other is told the slot is taken | winner dev.patel (RS-3DAVFP7VCN); the other saw: "That room is already reserved or being reviewed for part of this time. Choose another time or room." | PASS | [evidence/E-02.jpg](evidence/E-02.jpg) |
| F-01 | Scenario F | The winner cancels (two-step) and the room is released | Cancel asks for a second click; the reservation shows cancelled | "Reservation cancelled. The room is free for others."; card status: cancelled | PASS | [evidence/F-01.jpg](evidence/F-01.jpg) |
| F-02 | Scenario F | The other student now gets the same slot | The same room and time that was refused a moment ago is accepted | "Request submitted (RS-EXVJ2WKMX3). It is waiting for: College Dean. Follow its progress in" | PASS | [evidence/F-02.jpg](evidence/F-02.jpg) |
| AD-07 | Administrator | Reservation management | Statuses are filterable; confirmed, rejected, cancelled and pending requests are each listed | rows per status: {"pending":1,"confirmed":1,"rejected":1,"cancelled":1} | PASS | [evidence/AD-07.jpg](evidence/AD-07.jpg) |
| AD-08 | Administrator | Approval workflow configuration | The chain is edited (step time), saved with a new version, and restored | 2 approvers; 48 h -> 24 h saved ("Version 2, last changed Oct 13, 2026, 12:24 PM.") -> restored | PASS | [evidence/AD-08.jpg](evidence/AD-08.jpg) |
| AD-09 | Administrator | Audit log | Events are listed newest first with who and why; filtering by event type works | 26 events; filtered "ticket.revoked": ticket.revoked \| Demo Administrator (admin) \| Demonstration: wrong student at the desk | PASS | [evidence/AD-09.jpg](evidence/AD-09.jpg) |
| AD-10 | Administrator | Operations and diagnostics | Pending approval steps and email counts are shown; the consistency check agrees with itself | waiting on approvers: ; email: queued 0 sending 0 failed 0 sent 11; "Everything agrees (checked Oct 13, 2026, 12:24 PM)." | PASS | [evidence/AD-10.jpg](evidence/AD-10.jpg) |

## 3. UI/UX audit (`npm run test:ui`: 36 of 36 page views clean, Browser-scripted)

Every major page at a **desktop** viewport (1280 x 800) and a **phone** viewport (390 x 844, touch, mobile layout): login, sign-up, forgot password, terms, approver page, verify email, student Home / Reserve / Stubs / Reservations, and the eight administrator views. Per view: screenshot (`docs/evidence/ui/`), horizontal overflow, content wider than the screen, controls without names or labels, images without alt, duplicate ids, language and title, tiny tap targets, cramped controls, and console errors (a CSP violation would appear here). The scripted checks cannot judge appearance, so the screenshots were also reviewed by eye.

Defects the audit and the review found, all fixed, each with a regression test (`tests/unit/navigation.test.js` unless noted):

| Found | Fix |
|---|---|
| Phone layout of **Login**: two panels squeezed side by side, form clipped | Panels stack on phones |
| Phone layout of **every student and administrator page**: header and menu stayed fixed, only a 433 px strip scrolled | The whole page scrolls on phones |
| **Sign-up and reset pages**: fixed-height card cut off on short phones, unreachable Submit | Card grows with its content |
| Participants control had the **wrong label** (`for="room"`), so it was unlabeled for screen readers and Room had two labels | Label points at the right control (test checks every `for=`) |
| Participant **student-number field limited to 11 characters** (old format) | 24, as the neutral policy |
| Sign-in, sign-up and reset results shown with **blocking `alert()` pop-ups** | Inline, screen-reader-announced notices; sign-up returns to Login with the message |
| **Audit log "Reason"** for a revoked stub said "revoked" instead of the reason the administrator typed (`tests/reservations/ops.test.js`) | Shows what the person wrote |
| **Emails** gave deadlines as raw UTC (`2026-10-14T05:00:00.000Z`) for a Manila booking (`tests/unit/reservation-rules.test.js`, `ops.test.js`) | Local time, e.g. "14 Oct 2026, 1:00 pm (Asia/Manila)" |
| Demo **email viewer** redrew every 3 s, swallowing clicks and text selection | Redraws only on change |

Confirmation behaviour checked: destructive actions use a deliberate second step (retire a resource, cancel a reservation as student or administrator, revoke a stub needs a typed reason); check-in needs the ID attestation. Loading, empty and error states are present on every data view (observed in the screenshots and in walkthrough steps ST-03, AD-03, AD-05, AD-06).

## 4. Navigation and session behaviour (`npm run test:browser`: 16 of 16 scenarios, Browser-scripted)

Fresh sign-in 15 times (never anywhere but Home), admin sign-in, login after logout, early Enter and double submit, session restoration, direct protected-page access with return-to-page (including the admin section), role crossovers, 16 unsafe destinations, suspended and no-profile accounts, a slow 2.5 s network, two tabs, a cleared session, Back and Forward. Detail: README, "Sign-in navigation".

## 5. Print and QR (`npm run test:print`, Browser-scripted; rendering only)

Silent Room stub, Wi-Fi voucher and confirmed reservation: each prints on **one page**, nothing but the document is visible, the QR decodes (also at 60 % size), the payload equals the API's, the administrator scanner resolves it (`ticket` for NUFV1, `reservation` for NUFR1), the quiet zone is 4.3 modules (spec minimum 4). PDF and PNG in `docs/evidence/print/`. The Computer Station stub uses the identical template and was verified in Stage 9; it is left out of the npm command because which student holds a computer after the competition scenario is not fixed.

## 6. Cross-workflow scenarios

| Scenario | Result | Proof |
|---|---|---|
| A Register, verify, Silent Room stub, scan, check-in, check-out | PASS | walkthrough ST-01, ST-02, A-01 to A-04 |
| B Computer Station stub, administrator revokes | PASS | B-01, B-02, AD-09 (audit shows the reason) |
| C Wi-Fi voucher and its password | PASS | C-01 (same password on reopening; clearly marked demo) |
| D Reserve, Dean then Adviser approve by emailed link and code, final approval, confirmation QR scanned | PASS | D-01 to D-05; D-06 rejection with reason |
| E Two students, last computer; two students, one slot | PASS, exactly one winner each | E-01, E-02; also `tests/reservations/booking.test.js`, `races.test.js`, `tests/tickets/*` |
| F Cancellation frees the slot for another student | PASS | F-01, F-02 |

## 7. Not verified, and why

* **Physical camera scanning.** The scanner's decoding is proven on rendered QR images; no camera hardware was exercised.
* **Physical printer and paper.** Print was rendered by Chrome's print engine to PDF; no printer was used.
* **Real Firebase, real email, real deployment.** Everything ran on emulators and the in-memory email sink. Hosting-delivered security headers, real email delivery and the composite indexes are production-only checks (`docs/production-readiness.md`).
* **Other browsers and real phones.** Chrome only; the phone views are Chrome's mobile emulation, not physical devices.
* **Internet dependence.** Pages load the Firebase SDK, Font Awesome and Google Fonts from CDNs. A slow connection made a few scripted checks intermittent (they now wait for outcomes rather than fixed times); an offline run is not supported.
* **Human-factors judgement** (is it clear to a first-time student?) beyond the reviewed screenshots was not user-tested.
