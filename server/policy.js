// Institutional rules that have NOT been confirmed by the university, kept in one place so they can be tightened later.
// Nothing here may encode a guess about how NU Fairview formats identifiers or which email domains it owns.

// Student number: only what any identifier needs to be safe as a record key and readable on a printed stub (letters, digits
// and hyphens, 3 to 24 characters), compared case-insensitively so one number cannot be registered twice by typing it differently.
// shortcut: no institutional format is enforced. When the registrar confirms one, replace this pattern here and in
// public/register page/register.js (the client copy), and add a matching unit test.
export const STUDENT_NUMBER = /^[A-Z0-9][A-Z0-9-]{2,23}$/;
export const normalizeStudentNumber = (value) => (typeof value === 'string' ? value.trim().toUpperCase() : '');

// Email domain: not restricted. Accounts are created in the browser straight against Firebase Authentication, and blocking
// that at creation needs a Blaze-only blocking function, so on Spark the enforceable place is createStudentProfile() in
// routes/students.js (req.user.email is verified there): library services only work for accounts that have a profile.
