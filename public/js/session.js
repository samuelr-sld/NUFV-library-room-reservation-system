// Sign-in, session restoration and logout. This is UX only: every API call is re-verified by the Express backend
// and every Firestore read by the security rules, so a bypassed guard exposes nothing but static pages.
// createSession takes its Firebase operations as arguments so the logic is unit-testable in Node.

import { requestVerificationEmail, refreshVerification } from './verification.js';

const page = (path) => new URL(path, import.meta.url).href;
export const LOGIN_URL = page('../login page/login.html');
export const VERIFY_URL = page('../nav/verify/verify.html');
export const HOME = {
  student: page('../nav/main/main.html'),
  admin: page('../nav/admin/admin.html'),
};

// Where a sign-in may return to. Signing in sends a person to the page they asked for (the guard puts it in ?next=) only when
// it is one of these known pages for THEIR role; anything else (another role's page, another site, odd encodings, any query
// string) is ignored and they land on their home. The only fragment kept is a short section name on the administrator page.
export const RETURN_PAGES = {
  student: ['/nav/main/main.html', '/nav/reserve/reserve.html', '/nav/stubs/stubs.html', '/nav/reservations/reservations.html'],
  admin: ['/nav/admin/admin.html'],
};
const SECTION = /^#[a-z]{1,20}$/;

// Returns the absolute URL to return to, or null. `siteOrigin` is this site's own origin.
export function safeNext(raw, role, siteOrigin = new URL(import.meta.url).origin) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200 || /[\\\u0000-\u001f]/.test(raw)) return null;
  let url;
  try { url = new URL(raw, `${siteOrigin}/`); } catch { return null; }
  if (url.origin !== siteOrigin || url.search || !RETURN_PAGES[role]?.includes(url.pathname)) return null;
  if (url.hash && !(role === 'admin' && SECTION.test(url.hash))) return null;
  return `${siteOrigin}${url.pathname}${url.hash}`;
}

export const MESSAGES = {
  'bad-credentials': 'Incorrect email or password.', // one message so the form does not reveal which emails are registered
  suspended: 'This account is not active. Please contact the library.',
  'no-profile': 'This account has no student profile. Please register again or contact the library.',
  'rate-limited': 'Too many attempts. Please wait a few minutes and try again.',
  network: 'Cannot reach the server. Please try again.',
  unavailable: 'We could not verify your account. Please try again.',
};

export class LoginError extends Error {
  constructor(reason) {
    super(MESSAGES[reason] ?? MESSAGES['bad-credentials']);
    this.reason = reason;
  }
}

const AUTH_REASONS = {
  'auth/network-request-failed': 'network',
  'auth/user-disabled': 'suspended',
  'auth/too-many-requests': 'rate-limited',
};

// Decides what a signed-in user may see. requiredRole is omitted on pages open to both roles.
export function accessDecision(profile, requiredRole) {
  if (!profile || !(profile.role in HOME)) return { ok: false, reason: 'no-profile' };
  if (profile.status !== 'active') return { ok: false, reason: 'suspended' };
  if (requiredRole && profile.role !== requiredRole) return { ok: false, redirect: HOME[profile.role] };
  return { ok: true };
}

export function createSession({ getUser, signInWithPassword, signOut, readProfile, reloadUser = async () => {} }) {
  const quietSignOut = () => signOut().catch(() => {});

  return {
    // Result status: allow | redirect (wrong role) | unverified (student email not verified yet) | login (no session or
    // unusable account) | unavailable (could not verify). "unavailable" never signs the user out: an unreachable
    // backend must not destroy a valid session. Administrators are not subject to the verification requirement.
    async check(requiredRole, { requireVerified = false } = {}) {
      const user = await getUser();
      if (!user) return { status: 'login' };
      let profile;
      try {
        profile = await readProfile(user.uid);
      } catch {
        return { status: 'unavailable' };
      }
      const decision = accessDecision(profile, requiredRole);
      if (decision.ok) {
        if (requireVerified && profile.role === 'student' && !user.emailVerified) {
          // The flag may be stale (verified on another device): refresh it once before deciding.
          await reloadUser(user).catch(() => {});
          if (!user.emailVerified) return { status: 'unverified', profile };
        }
        return { status: 'allow', profile };
      }
      if (decision.redirect) return { status: 'redirect', to: decision.redirect };
      await quietSignOut();
      return { status: 'login', reason: decision.reason };
    },

    async login(email, password) {
      let user;
      try {
        user = await signInWithPassword(email, password);
      } catch (err) {
        throw new LoginError(AUTH_REASONS[err?.code] ?? 'bad-credentials');
      }
      let profile;
      try {
        profile = await readProfile(user.uid);
      } catch {
        await quietSignOut();
        throw new LoginError('unavailable');
      }
      const decision = accessDecision(profile);
      if (!decision.ok) {
        await quietSignOut();
        throw new LoginError(decision.reason);
      }
      return { role: profile.role, to: HOME[profile.role] };
    },

    logout: signOut,
  };
}

// Firebase is loaded lazily so the logic above can be imported in Node (firebase.js imports from URLs).
const SDK = 'https://www.gstatic.com/firebasejs/13.0.0';
let wired;
function wire() {
  wired ??= (async () => {
    const { auth, db } = await import('./firebase.js');
    const A = await import(`${SDK}/firebase-auth.js`);
    const F = await import(`${SDK}/firebase-firestore.js`);
    return {
      auth,
      A,
      session: createSession({
        getUser: async () => { await auth.authStateReady(); return auth.currentUser; },
        signInWithPassword: async (email, password) => (await A.signInWithEmailAndPassword(auth, email, password)).user,
        signOut: () => A.signOut(auth),
        reloadUser: (user) => user.reload(),
        readProfile: async (uid) => {
          const snap = await F.getDoc(F.doc(db, 'users', uid));
          return snap.exists() ? snap.data() : null;
        },
      }),
    };
  })();
  return wired;
}

export const session = {
  check: async (role, options) => {
    try {
      return await (await wire()).session.check(role, options);
    } catch {
      return { status: 'unavailable' };
    }
  },
  login: async (email, password) => (await wire()).session.login(email, password),
  logout: async () => (await wire()).session.logout(),
  async sendVerificationEmail() {
    const { auth, A } = await wire();
    return requestVerificationEmail(() => A.sendEmailVerification(auth.currentUser));
  },
  async refreshVerification() {
    const { auth } = await wire();
    return refreshVerification({
      reload: () => auth.currentUser.reload(),
      refreshToken: () => auth.currentUser.getIdToken(true),
      isVerified: () => auth.currentUser.emailVerified,
    });
  },
  // Fires when the user signs out elsewhere (another tab) after the page has loaded.
  async onSignedOut(callback) {
    const { auth, A } = await wire();
    A.onAuthStateChanged(auth, (user) => { if (!user) callback(); });
  },
};
