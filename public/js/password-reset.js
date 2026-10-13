// Result of a password-reset request, mapped to messages that never reveal whether an email is registered.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const RESET_MESSAGES = {
  sent: 'If an account exists for that email, a password reset link has been sent. Check your inbox and spam folder.',
  'invalid-email': 'Please enter a valid email address.',
  'rate-limited': 'Too many requests. Please wait a few minutes and try again.',
  network: 'Cannot reach the server. Please try again.',
  error: 'Something went wrong. Please try again later.',
};

export async function requestPasswordReset(send, rawEmail) {
  const email = rawEmail.trim();
  if (!EMAIL.test(email)) return 'invalid-email';
  try {
    await send(email);
    return 'sent';
  } catch (err) {
    switch (err?.code) {
      case 'auth/user-not-found': return 'sent'; // same answer as success: no account enumeration
      case 'auth/invalid-email': return 'invalid-email';
      case 'auth/too-many-requests': return 'rate-limited';
      case 'auth/network-request-failed': return 'network';
      default: return 'error';
    }
  }
}
