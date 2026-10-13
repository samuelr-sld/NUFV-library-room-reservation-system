# Gmail SMTP setup (optional live email)

Live email is **off by default**. `npm run demo`, `npm test` and `npm run server` use the in-memory email sink and send nothing. This guide turns on real delivery for the application's own emails through a dedicated Gmail account, and nothing else.

## Two kinds of email (do not confuse them)

| Kind | Examples | Sent by | Affected by this guide |
|---|---|---|---|
| **Application emails** | external-approver notice, approval one-time code, reservation outcome | this server, through the `emailOutbox` and the SMTP adapter | **Yes** |
| **Firebase Authentication emails** | verify your email, reset your password | Firebase (the emulator in development; real Firebase after migration) | **No** |

In the demo the viewer at `http://localhost:3000/api/dev/mail/view` shows both: the sink's messages (top) and the Auth emulator's links (bottom). With live mail on, the viewer is not mounted (there is no sink), and Firebase Authentication emails still come from the emulator, never from Gmail.

## 1. Create the App Password

1. Use a **dedicated** Gmail account for the library, not a personal one.
2. Turn on 2-Step Verification for it (Google Account > Security).
3. Open <https://myaccount.google.com/apppasswords>, create an app password named e.g. "NUFV Library", and copy the 16 characters (paste them **without spaces**). Google shows it once.

## 2. Configure (local, git-ignored)

Create `server/.env.local`. The repository ignores every `.env.*` file except `.env.example`; never put these values in `.env.example`, code, tests or documentation.

```
MAIL_TRANSPORT=smtp
MAIL_LIVE_APPROVED=yes
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=<the dedicated gmail address>
SMTP_PASS=<the app password, no spaces>
MAIL_FROM=<the same gmail address>
```

* Port 465 uses TLS from the first byte (`secure` is derived from the port).
* `MAIL_FROM` should equal `SMTP_USER`; Gmail rewrites any other sender to the account's own address.
* All six are required, plus `MAIL_LIVE_APPROVED=yes`. Anything missing makes the server or test command refuse to start, naming the setting (never its value).
* Credentials alone do nothing: without `MAIL_TRANSPORT=smtp` and `MAIL_LIVE_APPROVED=yes` the sink is used.

## 3. Send one safe test message

```
npm run mail:test -- --to someone@example.com
```

It sends **one** message to that one recipient, once (no outbox, no retry), only when you run it. It refuses without `--to`, without `MAIL_TRANSPORT=smtp`, with any setting missing, or without `MAIL_LIVE_APPROVED=yes`. Output is either `Sent one test message to ...` or `SMTP test failed: <reason>`; the password and username are masked in errors. Neither `npm test` nor `npm run demo` ever runs it.

## 4. Switch between sink and SMTP

| Goal | Command |
|---|---|
| Local demo (always the sink; any `MAIL_*`/`SMTP_*` variables in your shell are removed, and the launcher refuses `MAIL_TRANSPORT=smtp`) | `npm run demo` |
| API on the emulators with the sink | `npm run server` |
| API on the emulators with **live Gmail** (reads `server/.env.local`) | `npm run server:mail` |
| Back to the sink | stop the server and use `npm run server` |

With `server:mail` the accounts and approvers are still demo data (`@demo.nufv.test`), so those messages go nowhere real. To receive them, create an approval step with your own address in the admin screen.

If a message fails, the outbox keeps it: temporary errors (timeouts, 4xx) retry with backoff up to 6 attempts; a rejected login or address (5xx) fails at once and shows in Operations, where an administrator can send it again (except a discarded one-time code, which must be re-requested).

## Gmail limits

A regular Gmail account allows roughly **500 recipients per day** (Google Workspace roughly 2,000). Past it Gmail answers `550 5.4.5 Daily user sending quota exceeded` and may pause the account for about a day. Approval traffic here is tens of messages a day. The server delivers in small batches (10 per pass, one pass every 10 seconds), well under the limit.

## Common errors

| Error text | Meaning / fix |
|---|---|
| `535-5.7.8 Username and Password not accepted` | Wrong user, wrong app password, a revoked one, or the normal account password was used. Create a new app password. |
| `534-5.7.9 Application-specific password required` or `Please log in via your web browser` | 2-Step Verification is off, or the normal password was used. |
| `530 5.7.0 Authentication Required` | Credentials not sent: check `SMTP_USER`/`SMTP_PASS` in `server/.env.local`. |
| `Connection timeout` / `ECONNECTION` / `ETIMEDOUT` | Port 465 blocked by the network or a firewall; retried automatically. |
| `550 5.4.5 Daily user sending quota exceeded` | Daily limit hit; wait about 24 hours. |
| `Invalid server configuration: ... MAIL_LIVE_APPROVED=yes` | The explicit opt-in is missing or not exactly `yes`. |

Repeated failed logins can make Google lock the account. After an authentication error, fix the password rather than re-running the test.

## Revoke the App Password

Open <https://myaccount.google.com/apppasswords> and remove "NUFV Library" (or change the Google account password, which revokes all app passwords). Then delete `server/.env.local`. Delivery stops immediately; queued messages stay in the outbox.
