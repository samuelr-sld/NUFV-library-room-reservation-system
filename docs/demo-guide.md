# Academic demonstration guide

NUFV Library Services: Silent Room and Computer Station stubs, demo Wi-Fi vouchers, and Discussion Room reservations with sequential approval. About 25 minutes for the full sequence; each part stands alone.

Everything runs **on this computer, against emulators**. No real Firebase project, no real email, no real credentials. The passwords below are demonstration-only and public by design.

## 1. Prerequisites

| Need | Why |
|---|---|
| Node.js 20 or newer (tested on 24) | the API and the launcher |
| Java 21 or newer on `PATH` | the Firestore emulator (see README, "Local development on Windows", if `java -version` shows an older one) |
| Google Chrome (or any current browser) | the website; the QR scanner needs `localhost` or https |
| Internet access | the pages load the Firebase SDK, Font Awesome and Google Fonts from CDNs |
| Free ports 3000, 4000, 5000, 8080, 9099 | API, emulator console, website, Firestore, Authentication |
| Two browsers or one normal and one private window | one browser holds **one** signed-in person, so showing two people at once needs two (for example Chrome and a Chrome private window) |

One time: `npm install`.

## 2. Start

```
npm run demo
```

Wait for the banner ("demonstration environment is running", about 30 to 60 seconds). It starts the Authentication and Firestore emulators, the Express API with an **in-memory email sink**, and the website, then creates the demo accounts and inventory. Open:

| What | Address |
|---|---|
| The website | <http://localhost:5000/login%20page/login.html> |
| **Email sink viewer** (keep this tab open) | <http://localhost:3000/api/dev/mail/view> |
| Emulator console (optional, shows raw data such as accounts) | <http://localhost:4000> |

Stop with **Ctrl+C**. Starting again always gives a clean slate (the emulators keep nothing). It cannot touch real data: the launcher fixes the environment to a `demo-*` project on loopback emulators and refuses anything else (`server/demo.js`, tested).

> **No real email is ever sent in the demonstration.** When a page says an email was sent (sign-up, verification, password reset, approval code), it shows a yellow "Demo mode" note with a link to the **email sink viewer**, where that message and its links appear. Keep that tab open.

## 3. Demonstration accounts

Password for **every** account: `demo1234`

| Role | Email | Use it for |
|---|---|---|
| Administrator | `admin@demo.nufv.test` | scanning, inventory, approvals, audit |
| Student | `ana.reyes@demo.nufv.test` | Computer Station stub, revocation |
| Student | `ben.cruz@demo.nufv.test` | Wi-Fi voucher |
| Student | `carla.lim@demo.nufv.test` | the reservation and its approvals |
| Student | `dev.patel@demo.nufv.test`, `eli.tan@demo.nufv.test` | two students competing |
| Student, email **not verified** | `una.unverified@demo.nufv.test` | the verification screen |
| Student, **suspended** | `sam.suspended@demo.nufv.test` | access denied |
| Signed up, **no profile** | `nina.noprofile@demo.nufv.test` | access denied |
| External approvers (no account, just addresses) | `dean@demo.nufv.test`, then `adviser@demo.nufv.test` | they act from links in the email sink |

Seeded inventory: 3 silent seats, 2 computer stations, 3 discussion rooms (A for 6, B for 4, C for 10) and an approval chain of **College Dean, then Library Adviser, then the administrator**.

## 4. The sequence

Keep the **email sink viewer** open in its own tab throughout.

### Part 1 Registration, verification, home (4 min)

1. Sign-up page (link on the login page). Submit it **empty**: the browser stops it. Enter *Name* "Nora Villanueva", *Student number* anything such as `demo-1001` (no university format is enforced; it is stored in capitals), *Email* `nora@demo.nufv.test`, a password, tick the terms (the **terms and conditions** link opens a dialog), **Submit**.
2. You return to **Login** with "Account created. Check your email…". Log in: you are held on **Verify your email**. Click *I have verified my email*: "not verified yet".
3. Verify: in the **email sink viewer**, scroll to **Account emails (Firebase Authentication, emulated)**: the *Verify your email address* link for Nora is there. Open it (this is what clicking the link in a real email does), then click *I have verified my email* again: you land on **Student Home**.
4. Home shows today's rooms (status "for right now"), "You have no upcoming reservations", and an honest note that there are no announcements. Nothing on it is invented.

*Short on time:* skip registration and use `ana.reyes@demo.nufv.test`, who is already verified, and show `una.unverified@demo.nufv.test` only for the verification screen. Password reset works the same way: *Forgot password* on the login page, then the *Reset your password* link in the same viewer section (the emulator wants `&newPassword=` and the new password added to the end of that address, as the viewer says).

### Part 2 Scenario A: Silent Room stub, QR, check-in, check-out (4 min)

1. As Nora: **Generate Stubs** → *Silent Room* → **Generate stub**. A stub appears with a seat (for example "Silent Seat 1"), a ticket id `SR-…` and a **QR code**. Point out **View / print** and that the stub is listed under *Active* and in *History*.
2. In the second browser, sign in as the **administrator** → **Scan Codes**. Either click **Start camera** and show the QR on the stub (a phone or a printed copy works best; allow the camera), **or** type the ticket id from the stub (for example `SR-8Y0ZFX03R3`) into *Code, ticket ID or reservation reference* and **Look up**.
3. The scanner shows **ISSUED**, the student and the seat. Note the **Check in** button is disabled until you tick *I checked the student's ID*. Tick it, **Check in** ("Checked in."), then **Check out** ("Checked out."). In Nora's browser the stub is now in History as *checked out*, and the seat is free again.

### Part 3 Scenarios B and C: revoke and voucher (3 min)

1. As Ana: generate a **Computer Station** stub (`CS-…`). As admin: look it up, **Revoke…**, type a reason, **Confirm revoke**. Ana's Active list is empty and History shows *revoked*.
2. As Ben: generate a **Wi-Fi Voucher**. A clearly marked **DEMO password** appears (`DEMO-XXXX-XXXX-XXXX`); closing and reopening it shows the same password. It works on no real network.

### Part 4 Scenario D: reservation with sequential approval (7 min)

1. As Carla: **Reserve Room** → Discussion Room A, tomorrow's date, 9:00 AM to 10:00 AM, 2 participants (fill the other participant's name), a purpose → **Submit**. The page says it is waiting for **College Dean**. **My Reservations** shows the progress tracker: Dean *waiting*, Adviser *not reached*, Final approval *not reached*.
2. **Simulated email approval** (the heart of the demo; see section 5): in the email sink viewer the Dean's message "Approval requested: College Dean" appears. Open its link.
3. On the approval page: **Send me a code**; the viewer now shows a second email with a highlighted six-digit code; enter it, **Verify**; the page shows the request (student, room, time, purpose); add a comment and **Approve**.
4. Back in the sink the **Library Adviser** is notified only now. Repeat: link, code, approve.
5. As admin: **Reservations** → the request says **Needs your decision** → **Open** → **Give final approval**.
6. As Carla: the reservation is **confirmed**; **View / print confirmation** shows reference `RC-…` and a QR.
7. As admin: **Scan Codes** with that QR (camera) or by typing the `RC-…` reference. The scanner shows the student, room, approved time, **CONFIRMED**, and "Not valid right now. The booking has not started yet." (it becomes valid only inside its time). Mention that reservations are checked, not checked in.
8. Optional: submit a second request and have the Dean **Reject** with a comment; Carla sees the reason on her card.

### Part 5 Scenarios E and F: competition and cancellation (4 min)

1. Make exactly one computer free: as admin **Resources** → edit `pc-02` to *maintenance* (Ana's revoked stub already freed `pc-01`).
2. As Dev (browser 1) and Eli (browser 2), both open **Generate Stubs**, choose *Computer Station* and press **Generate stub** at the same moment. **Exactly one** gets a stub; the other is told none is free.
3. Both then open **Reserve Room**, choose the same room and the same time, and press **Submit** together. **Exactly one** request is accepted; the other is told the room is already reserved.
4. The winner opens **My Reservations** and cancels (two clicks: *Cancel reservation*, then *Confirm cancel*). The other student submits the same slot again and now succeeds.

### Part 6 Administrator tour (3 min)

**Overview** (inventory counts), **Resources** (add one, edit, the two-click retire), **Approval Chain** (the approvers and the step time are editable; changes affect only new requests), **System Settings** (limits with validation), **Audit Log** (filter by `ticket.revoked`: who, when, and the reason typed), **Operations** (what is waiting on approvers, email delivery, and the consistency check: "Everything agrees").

## 5. Simulated email approval, step by step

The external approvers have no account. They act only from emailed links, and here the "email" is the sink viewer.

1. Student submits a reservation → the sink shows **"Approval requested: …"** to the next approver with a link `http://localhost:5000/approve/approve.html#…`.
2. Open the link. **Opening it alone approves nothing.** Click **Send me a code**.
3. The sink shows **"Your approval code"** with a highlighted six-digit number. Enter it. It works once and expires in 10 minutes; five wrong tries lock the request (then the administrator uses **Reservations → Open → Send the request again**).
4. Review the request, add an optional comment, **Approve** or **Reject**. The step closes; the next approver (or the administrator) is notified.

## 6. QR verification, step by step

* **Stubs** carry `NUFV1:…`; **reservation confirmations** carry `NUFR1:…`. Both go through the same **Scan Codes** screen.
* **With a camera:** *Start camera*, allow access, hold the QR in view. Show it on a phone or print it (**Print** gives a clean one-page document). The camera is optional.
* **Without a camera:** type the ticket id (`SR-…`, `CS-…`, `WF-…`) or the confirmation reference (`RC-…`). Always works.
* A code only says what it refers to. For stubs the administrator must still tick that they checked the student's ID.

## 7. If a step goes wrong

| Symptom | Fix |
|---|---|
| `npm run demo` says Java is missing or too old | Install Java 21, restart the terminal, `java -version`. |
| "Cannot start: port(s) ... already in use" | An earlier demo is still running: Ctrl+C it (or close its terminal) and start again. |
| A page says an email was sent but none arrived | Correct in demo mode: nothing is ever sent. Open the email sink viewer (the yellow note links to it). |
| Page blank or "We could not verify your session" | Internet is needed for the SDK; check connection; reload. |
| Approval link says "This request is not open" | It was already decided, cancelled, replaced, or timed out. Submit a new reservation. |
| No email in the sink | The API was restarted (the sink is in memory) or the 10-second delivery tick has not run; wait a few seconds, reload the viewer. |
| Approval code rejected / locked | A new code can be requested after 30 seconds. After too many wrong codes, as admin: Reservations → Open → **Send the request again**. |
| "You already have the maximum of 1 active stub" | Check the student out, or revoke the stub, or use another student. |
| A room "is already reserved" | By design: pick another time or room, or cancel the other request. |
| Camera will not start | Allow it for `localhost`, close other apps using it, or type the code. |
| Student cannot log in after you changed things | Restart for a clean slate: Ctrl+C, then `npm run demo`. |
| Anything odd | Restart. The demo is reproducible in under a minute. |

## 8. Where the evidence is

* `docs/test-matrix.md`: every checked behavior, expected versus actual, and which are automated or observed by hand.
* `docs/evidence/`: one screenshot per walkthrough step; `docs/evidence/ui/` every page at desktop and phone size; `docs/evidence/print/` the printable documents as PDF and PNG.
* Re-run the checks (with `npm run demo` running): `npm run test:walkthrough` (needs a fresh demo), `npm run test:ui`, `npm run test:browser`, `npm run test:print`. The automated suite is `npm test` (needs the demo stopped).
