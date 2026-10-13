// Email verification helpers. Pure (Firebase operations are passed in) so they are unit-testable.
// The browser flag is only a convenience: the Express API trusts the email_verified claim in the signed ID token,
// which is why refreshing means reloading the user AND forcing a new token.

export const VERIFY_MESSAGES = {
  sent: 'Verification email sent. Check your inbox and spam folder, then choose "I have verified my email".',
  verified: 'Your email is verified. Taking you to the dashboard...',
  pending: 'Your email is not verified yet. Open the link in the email we sent you, then try again.',
  'rate-limited': 'Too many requests. Please wait a few minutes before asking for another email.',
  network: 'Cannot reach the server. Please try again.',
  error: 'Something went wrong. Please try again later.',
};

const CODES = {
  'auth/too-many-requests': 'rate-limited',
  'auth/quota-exceeded': 'rate-limited',
  'auth/network-request-failed': 'network',
};

export async function requestVerificationEmail(send) {
  try {
    await send();
    return 'sent';
  } catch (err) {
    return CODES[err?.code] ?? 'error';
  }
}

// 'verified' only after the token was refreshed, so the next API call carries email_verified: true.
export async function refreshVerification({ reload, refreshToken, isVerified }) {
  try {
    await reload();
    if (!isVerified()) return 'pending';
    await refreshToken();
    return 'verified';
  } catch (err) {
    return CODES[err?.code] ?? 'error';
  }
}
