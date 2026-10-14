# NUFV Library Services — Functional Test Case Inventory

This inventory lists the functional and security test cases identified from the implemented features of the NUFV Library Services web application (discussion-room reservation with sequential approval, computer-station and silent-study-seat tickets, Wi-Fi voucher tickets, administrator console). Only functionality confirmed in the codebase is included.

## 1. User Registration and Authentication

| Test Case ID | Test Case Description |
|---|---|
| TC-001 | User must be able to register a student account by providing a full name, student number, email address, password and acceptance of the Terms and Conditions. |
| TC-002 | System must prevent registration when required fields are empty, the passwords do not match, or the Terms and Conditions are not accepted. |
| TC-003 | System must prevent registration when the student number is malformed (outside 3 to 24 letters, digits or hyphens). |
| TC-004 | System must prevent registration with an email address that is already in use. |
| TC-005 | System must prevent the same student number from being registered twice, regardless of letter case. |
| TC-006 | System must always create new accounts with the student role, ignoring any role supplied by the client. |
| TC-007 | System must send a verification email after registration, and allow the user to request it again after a waiting period. |
| TC-008 | User must be able to confirm email verification from the verification page and be taken to the student dashboard. |
| TC-009 | System must prevent students with unverified email addresses from using library services (reservations, tickets, and student pages). |
| TC-010 | User must be able to log in with valid credentials and be directed to the home page for their role (student or administrator). |
| TC-011 | System must reject login with incorrect credentials using a single generic message that does not reveal whether the email is registered. |
| TC-012 | System must prevent suspended or profile-less accounts from logging in. |
| TC-013 | System must limit repeated failed login attempts and inform the user to wait. |
| TC-014 | User must be able to log out and be returned to the login page. |
| TC-015 | System must redirect unauthenticated visitors from protected pages to the login page, and return them to the requested page after login only if it is a permitted page for their role. |
| TC-016 | System must redirect a user who opens a page belonging to the other role to their own home page. |
| TC-017 | System must restore an existing valid session without requiring the user to log in again, and sign the user out of open pages when the session ends elsewhere. |
| TC-018 | User must be able to request a password reset email from the Forgot Password page. |
| TC-019 | System must show the same confirmation message for registered and unregistered emails during password recovery. |
| TC-020 | System must reject an invalid email format on the Forgot Password page and limit repeated reset requests. |

## 2. User Profile Management

| Test Case ID | Test Case Description |
|---|---|
| TC-021 | Student and administrator must be able to view their own profile (name, email, role, status, student number, course, address, email verification state). |
| TC-022 | User must be able to update their full name, course and address. |
| TC-023 | System must reject profile updates that are empty, too long, contain control characters, or are not text. |
| TC-024 | System must prevent changes to protected fields (email, student number, role, status) through the profile feature. |
| TC-025 | System must restrict each user to their own profile, using the identity from the verified login token only. |
| TC-026 | System must record profile changes in the audit log, and must not record anything when no value actually changed. |
| TC-027 | User must be able to request a password reset email from the profile page. |
| TC-028 | System must refuse profile access for suspended accounts or accounts without a profile. |

## 3. Resource Management

| Test Case ID | Test Case Description |
|---|---|
| TC-029 | Administrator must be able to create a discussion room with a valid identifier, label, description and capacity. |
| TC-030 | Administrator must be able to create computer stations and silent study seats without a capacity value. |
| TC-031 | System must prevent creating a resource with an invalid identifier, unknown type, invalid label, unknown field, or an identifier that already exists. |
| TC-032 | System must prevent a capacity outside 1 to 50 for discussion rooms and prevent any capacity on other resource types. |
| TC-033 | Administrator must be able to edit a resource's label, description and capacity. |
| TC-034 | System must prevent changing a resource's identifier or type after creation. |
| TC-035 | Administrator must be able to change a resource's status between active and maintenance. |
| TC-036 | System must prevent taking a resource out of service while it is assigned, occupied or held by a ticket. |
| TC-037 | System must prevent taking a discussion room out of service while it has pending or upcoming reservations. |
| TC-038 | Administrator must be able to retire a resource (soft delete), and the system must prevent any further changes to a retired resource. |
| TC-039 | Administrator must be able to filter the resource list by type and status, and the system must reject unknown filter values. |
| TC-040 | System must show a resource as available only when it is active and has no assignment, occupancy or hold. |
| TC-041 | Administrator must be able to view the resource summary (totals, active, maintenance, retired, in use, available per resource type). |
| TC-042 | System must reflect added, edited or retired resources in the quantities and options offered to students (rooms list, seat and station availability). |
| TC-043 | Administrator must be able to view and update system settings (ticket durations, no-show grace period, tickets per student, booking interval, advance-booking days, Wi-Fi voucher duration). |
| TC-044 | System must reject settings that are out of range, not whole numbers, unknown, or that make the no-show grace period longer than a ticket's duration. |
| TC-045 | System must apply changed settings only to tickets and reservations created afterwards. |

## 4. Student Reservation and Ticketing

| Test Case ID | Test Case Description |
|---|---|
| TC-046 | Student must be able to view the active discussion rooms, booking rules (hours, interval, advance days) and room availability for a chosen date. |
| TC-047 | Student must be able to submit a discussion-room reservation with room, date, start and end time, purpose, participants and optional special requests. |
| TC-048 | System must reject reservations with a past start time, an end time not after the start, times off the booking interval, or times outside library hours. |
| TC-049 | System must reject reservations longer than the maximum duration or further ahead than the allowed number of days. |
| TC-050 | System must reject reservations exceeding the room's capacity or containing invalid participant details, purpose or notes. |
| TC-051 | System must prevent reservations for unavailable (maintenance or retired) or non-existent rooms. |
| TC-052 | System must prevent two overlapping reservations for the same room, while allowing back-to-back bookings. |
| TC-053 | System must ensure only one of several simultaneous overlapping requests succeeds. |
| TC-054 | System must limit each student to three open reservations at a time. |
| TC-055 | System must limit how often a student can submit reservation requests. |
| TC-056 | Student must be able to see the status and approval progress of each reservation (pending, confirmed, rejected, cancelled, expired). |
| TC-057 | Student must be able to cancel their own pending or upcoming confirmed reservation, and the room must be released. |
| TC-058 | System must prevent cancellation of reservations that have already started or ended, and repeated cancellation must change nothing. |
| TC-059 | System must provide a confirmation reference and QR code only for confirmed reservations, and allow the student to print the confirmation. |
| TC-060 | System must refuse to print a reservation that is not confirmed. |
| TC-061 | System must prevent a student from viewing, cancelling or printing another student's reservation. |
| TC-062 | System must expire a pending reservation when its approval deadline passes or its start time arrives, and release the room. |
| TC-063 | Student must be able to see the live availability of silent study seats, computer stations and Wi-Fi vouchers. |
| TC-064 | Student must be able to generate a silent study seat ticket or computer station ticket, and the system must assign the lowest free active seat or station. |
| TC-065 | Student must be able to generate a Wi-Fi voucher ticket, with the voucher password shown only on the owner's printable stub while the ticket is active. |
| TC-066 | System must generate a QR code for every ticket and allow the student to print it. |
| TC-067 | System must return the existing active ticket when a student requests the same service again, instead of creating a duplicate. |
| TC-068 | System must prevent a student from exceeding the maximum number of active tickets. |
| TC-069 | System must report that no seat or station is available when all active resources are in use. |
| TC-070 | System must prevent two students from being assigned the same seat or station, including simultaneous requests. |
| TC-071 | System must reject unknown service names when generating a ticket. |
| TC-072 | Student must be able to view their active tickets and ticket history (limited to a valid page size). |
| TC-073 | System must expire a ticket at its end time, and expire an unchecked-in ticket after the no-show grace period, releasing the seat. |
| TC-074 | System must prevent a student from viewing or printing another student's ticket. |
| TC-075 | System must prevent administrator accounts from using student reservation and ticket services. |

## 5. Sequential Reservation Approval

| Test Case ID | Test Case Description |
|---|---|
| TC-076 | Administrator must be able to configure an ordered list of external approvers (label, email, enabled) and the hours allowed per approval step. |
| TC-077 | System must reject approval-chain settings with invalid emails, labels, unknown fields, more than five approvers, or the same email on two enabled steps. |
| TC-078 | System must always append final administrator approval after the enabled external approvers. |
| TC-079 | System must freeze the approval chain at the time of submission so later configuration changes do not affect requests already in progress. |
| TC-080 | System must start approval with External Approver 1 on submission and move to External Approver 2 only after approval at step 1. |
| TC-081 | System must move to final administrator approval only after all external approvers have approved. |
| TC-082 | System must confirm the reservation, assign its confirmation reference and QR code, and keep the room booked after final administrator approval. |
| TC-083 | External approver must be able to open the approval link and see only the step label and a masked email address, without reservation details. |
| TC-084 | External approver must be able to request a one-time code, which is emailed to the address bound to that approval step and never displayed by the system. |
| TC-085 | System must limit code requests (waiting time between requests and maximum number of codes per approval). |
| TC-086 | External approver must be able to verify a valid six-digit code and view the reservation details, student, and previous approvals. |
| TC-087 | System must reject codes that are incorrectly formatted, wrong, expired or already used. |
| TC-088 | System must lock a code after repeated wrong attempts and lock the whole approval after too many total wrong attempts. |
| TC-089 | External approver must be able to approve or reject with an optional comment of up to 300 characters. |
| TC-090 | System must reject approval decisions without a valid verification session, or with an expired session. |
| TC-091 | System must allow only one decision per approval link and refuse repeated or replayed decisions. |
| TC-092 | System must prevent an approval link from affecting any step other than the one it was issued for. |
| TC-093 | System must release the room and notify the student when an external approver rejects the request. |
| TC-094 | System must close an approval and release the room when the step deadline passes without a decision. |
| TC-095 | System must show a "not open" state for approval links that are invalid, closed, expired or superseded. |
| TC-096 | System must limit the rate of requests to the public approval endpoints. |
| TC-097 | Administrator must be able to approve or reject a reservation at the final step only, with an optional comment. |
| TC-098 | System must prevent administrators from approving or rejecting an external approver's step on their behalf. |
| TC-099 | System must prevent a decision on a step that is not the current step, or on a reservation that is already decided. |
| TC-100 | System must prevent students from approving or rejecting any reservation step. |

## 6. Email Notifications

| Test Case ID | Test Case Description |
|---|---|
| TC-101 | System must send an email verification message when a student registers or requests it again. |
| TC-102 | System must send a password reset email to registered accounts when requested. |
| TC-103 | System must email an approval invitation with a review link to each external approver when their step begins. |
| TC-104 | System must state in the invitation email that opening the link alone does not approve or reject anything. |
| TC-105 | System must email the one-time approval code only to the approver's bound address and only on request. |
| TC-106 | System must notify the student by email when a reservation is confirmed, rejected, cancelled or expired. |
| TC-107 | System must queue each notification together with the change that causes it, so a change and its email never exist separately. |
| TC-108 | System must retry failed email deliveries with increasing delays and mark a message as failed after the maximum number of attempts. |
| TC-109 | System must not queue duplicate notifications for the same event. |
| TC-110 | System must remove the content of one-time-code emails after delivery ends. |
| TC-111 | Administrator must be able to resend the approval invitation for a pending external step, and the previous link must stop working. |
| TC-112 | Administrator must be able to view email delivery counts and failed messages without seeing message bodies, and re-queue a failed message. |
| TC-113 | System must refuse to re-queue messages that are not failed, whose one-time code was discarded, or whose approval link is no longer current. |

## 7. Administrator Functions

| Test Case ID | Test Case Description |
|---|---|
| TC-114 | Administrator must be able to view the dashboard overview of resources by type and current system settings. |
| TC-115 | Administrator must be able to list reservations by status (pending, confirmed, rejected, cancelled, expired) and open reservation details. |
| TC-116 | Administrator must be able to see the approval chain, current step, approvals and chronological history of each reservation. |
| TC-117 | Administrator must be able to cancel a pending or confirmed reservation with a reason. |
| TC-118 | System must reject reservation status filters that are not recognised. |
| TC-119 | Administrator must be able to scan or manually enter a ticket QR code or ticket ID to see the ticket, student, status and permitted actions. |
| TC-120 | Administrator must be able to check in a student only after confirming that the student's identity was checked. |
| TC-121 | Administrator must be able to check out a checked-in student, releasing the seat. |
| TC-122 | Administrator must be able to revoke an active ticket by giving a reason of 3 to 200 characters. |
| TC-123 | System must prevent check-in of expired, revoked, no-show or already closed tickets, and prevent check-in of Wi-Fi vouchers. |
| TC-124 | System must handle repeated check-in or check-out of the same ticket without changing the record twice. |
| TC-125 | System must warn the administrator when the ticket's student is not active or the assigned seat no longer belongs to the ticket. |
| TC-126 | Administrator must be able to scan a reservation QR code or confirmation reference and see read-only validity information without check-in actions. |
| TC-127 | System must reject malformed or unknown ticket and reservation codes. |
| TC-128 | Administrator must be able to view the approvals overview (pending steps, challenge state, notice state, recently expired requests). |
| TC-129 | Administrator must be able to view the audit log with filtering by action or target, paging, and valid limits. |
| TC-130 | System must record audit entries for registration, profile changes, resource changes, settings changes, ticket actions, reservation actions, approval decisions and approver lockouts. |
| TC-131 | System must hide secrets (codes, sessions, hashes, passwords, QR references) from audit log output. |
| TC-132 | Administrator must be able to run the read-only diagnostics check for inconsistent seat allocations, reservation holds and approval records. |
| TC-133 | System must keep ticket, seat allocation and reservation slot records consistent after check-in, check-out, revoke, cancel and expiry. |

## 8. System Security and Data Integrity

| Test Case ID | Test Case Description |
|---|---|
| TC-134 | System must reject API requests that have no valid login token, an invalid token, or an expired or revoked token. |
| TC-135 | System must prevent students from accessing any administrator function. |
| TC-136 | System must determine a user's role from the stored profile rather than from the request or token claims. |
| TC-137 | System must prevent suspended administrators and students from using the system. |
| TC-138 | System must deny direct client access to protected database collections (tickets, reservations, resources, settings, audit logs, approval records, email queue), allowing users to read only their own profile. |
| TC-139 | System must reject requests whose body is not a valid JSON object, contains unknown fields, or exceeds the size limit. |
| TC-140 | System must reject state-changing requests from origins that are not allowed. |
| TC-141 | System must prevent API responses containing personal data, tickets or codes from being cached. |
| TC-142 | System must store Wi-Fi voucher passwords and approval codes and sessions only in protected form, and never in audit logs or list responses. |
| TC-143 | System must not reveal whether a record belongs to another user, responding the same as for a record that does not exist. |
| TC-144 | System must preserve records (resources, tickets, reservations, audit entries) rather than deleting them. |
| TC-145 | System must process simultaneous or repeated requests for the same ticket, reservation or approval so that only one outcome takes effect. |
| TC-146 | System must apply server time to decide expiry, so that an overdue ticket or reservation cannot be checked in, approved or confirmed. |
| TC-147 | System must keep data stored after a server restart. |
| TC-148 | System must apply security response headers (content security policy, frame protection, no content sniffing, no referrer) to pages. |
| TC-149 | System must refuse to start with an invalid or unsafe configuration, such as emulator settings in production or a missing secret. |
| TC-150 | System must refuse to start with the demonstration email sink in production mode. |

## 9. LAN Demonstration Mode

| Test Case ID | Test Case Description |
|---|---|
| TC-151 | System must by default accept connections only from the local computer (localhost). |
| TC-152 | System must accept connections from other devices on the same network only when LAN mode is explicitly enabled. |
| TC-153 | System must refuse to enable LAN mode outside the cloud development configuration. |
| TC-154 | System must refuse to start LAN demonstration mode when its configuration is missing, or when the approval-link base address is not the laptop's network address on the website port. |
| TC-155 | System must start the website and the API together in LAN demonstration mode and stop both when either one stops. |
| TC-156 | Students and administrator must be able to use the system from the host computer through localhost while LAN mode is active. |
| TC-157 | External approver must be able to open the emailed approval link from another device on the hotspot and complete verification and a decision. |
| TC-158 | System must allow the approval page opened through the network address to connect to the API on the same host. |
| TC-159 | System must allow API requests from the network address only when that address is in the allowed origins list. |
| TC-160 | System must refuse login and student/administrator sign-in pages opened through the network address. |

---

## Summary

**Total number of identified test cases: 160**

| Category | Test Cases | Count |
|---|---|---|
| 1. User Registration and Authentication | TC-001 – TC-020 | 20 |
| 2. User Profile Management | TC-021 – TC-028 | 8 |
| 3. Resource Management | TC-029 – TC-045 | 17 |
| 4. Student Reservation and Ticketing | TC-046 – TC-075 | 30 |
| 5. Sequential Reservation Approval | TC-076 – TC-100 | 25 |
| 6. Email Notifications | TC-101 – TC-113 | 13 |
| 7. Administrator Functions | TC-114 – TC-133 | 20 |
| 8. System Security and Data Integrity | TC-134 – TC-150 | 17 |
| 9. LAN Demonstration Mode | TC-151 – TC-160 | 10 |
| **Total** | | **160** |

## Functionality That Could Not Be Fully Verified From the Codebase

- **Verification and password-reset email content and delivery.** These emails are generated and sent by Firebase Authentication, not by this application's code, so their wording, sender and delivery cannot be confirmed from the repository (TC-007, TC-018, TC-027, TC-101, TC-102). In demonstration mode a local mail viewer shows them.
- **Email domain restriction.** The code states that no university email domain or student-number format is enforced, so no such test cases were written.
- **Administrator-managed user accounts.** No feature exists to suspend, reactivate or edit other users' accounts through the application. Suspended-account cases (TC-012, TC-028, TC-137) assume the status was set directly in the database. Administrator accounts are created by an operator script, not through registration.
- **Reservation attendance.** Reservation QR codes are read-only for administrators; there is no check-in or check-out for discussion rooms (stated in the code as awaiting an approved policy).
- **Wi-Fi vouchers.** These are demonstration credentials only and do not connect to a real university network.
- **Rejection or cancellation emails to approvers.** No notification to external approvers is implemented after their step ends, so none was listed.
- **Live email delivery.** Real SMTP (Gmail) delivery depends on operator configuration and could not be confirmed from the code alone.
- **Hotspot reachability.** Whether a phone can actually reach the laptop (firewall, hotspot isolation, IP changes) depends on the network environment. TC-157 and TC-158 can only be confirmed by physical testing.
- **Production hosting.** Firebase Hosting headers and deployment are defined in configuration but were not confirmed against a deployed site.
