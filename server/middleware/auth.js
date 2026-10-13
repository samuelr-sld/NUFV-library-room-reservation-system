import { HttpError } from '../errors.js';

// Verifies the Firebase ID token (signature, expiry, revocation, disabled user) and sets req.user.
// Identity comes only from the verified token, never from the request body.
export const authenticate = ({ auth }) => async (req, res, next) => {
  const token = /^Bearer (\S+)$/.exec(req.get('authorization') ?? '')?.[1];
  if (!token) throw new HttpError(401, 'unauthenticated', 'Sign in to continue.');

  let decoded;
  try {
    decoded = await auth.verifyIdToken(token, true);
  } catch (err) {
    if (err.code === 'auth/user-disabled') throw new HttpError(403, 'account-suspended', 'This account is suspended.');
    throw new HttpError(401, 'invalid-token', 'Your session is not valid. Please sign in again.');
  }
  if (!decoded.email) throw new HttpError(401, 'unauthenticated', 'Sign in with an email account first.');

  // email_verified comes from the signed token, so it is only as fresh as the token (clients refresh it after verifying).
  req.user = { uid: decoded.uid, email: decoded.email, emailVerified: decoded.email_verified === true };
  next();
};

// Privileged student actions call this after authenticate. 403 (not 401): the session is valid, the account is not eligible yet.
export const requireVerifiedEmail = (req, res, next) => {
  if (!req.user.emailVerified) throw new HttpError(403, 'email-not-verified', 'Verify your email address to use library services.');
  next();
};

// The Firestore profile must exist and be active; the role is not checked.
export const requireActiveProfile = ({ db }) => async (req, res, next) => {
  const profile = await db.doc(`users/${req.user.uid}`).get();
  if (!profile.exists) throw new HttpError(403, 'no-profile', 'This account has no profile.');
  if (profile.get('status') !== 'active') throw new HttpError(403, 'account-suspended', 'This account is suspended.');
  next();
};

// Student-only library services: an active profile with the student role. The profile is exposed as req.profile.
export const requireActiveStudent = ({ db }) => async (req, res, next) => {
  const profile = await db.doc(`users/${req.user.uid}`).get();
  if (!profile.exists) throw new HttpError(403, 'no-profile', 'This account has no profile.');
  if (profile.get('role') !== 'student') throw new HttpError(403, 'forbidden', 'This service is for students.');
  if (profile.get('status') !== 'active') throw new HttpError(403, 'account-suspended', 'This account is suspended.');
  req.profile = profile.data();
  next();
};

// Role comes from the Firestore profile (the source of truth), not from token claims or the client.
export const requireAdmin = ({ db }) => async (req, res, next) => {
  const profile = await db.doc(`users/${req.user.uid}`).get();
  if (!profile.exists || profile.get('role') !== 'admin') {
    throw new HttpError(403, 'forbidden', 'You do not have access to this resource.');
  }
  if (profile.get('status') !== 'active') throw new HttpError(403, 'account-suspended', 'This account is suspended.');
  next();
};
