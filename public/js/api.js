// Calls the Express API with the signed-in user's Firebase ID token.
// Errors are always ApiError with a message that is safe to show to students; server internals never leak.
import { apiBaseFor } from './firebase-config.js';

export class ApiError extends Error {
  // uncertain: the request may have reached the server and changed data (timeout, dropped connection, 5xx).
  // Only an error in this API's own envelope ({error:{code}}, status < 500) is a definitive "nothing was written":
  // a bare 4xx (proxy timeout, rate limiter, wrong host) says nothing about what the server did.
  constructor(code, message, status = 0, uncertain = false) {
    super(message);
    this.code = code;
    this.status = status;
    this.uncertain = uncertain;
  }
}

const GENERIC = 'Something went wrong. Please try again later.';
// Statuses whose server message is written for end users (validation, conflicts, suspension).
const USER_FACING = [400, 403, 404, 409, 503]; // 503 is the API's own "busy, try again"

export function createApiClient({ getToken, baseUrl, fetchFn = (...a) => fetch(...a), timeoutMs = 15000 }) {
  return async function request(path, { method = 'GET', body } = {}) {
    let token;
    try {
      token = await getToken();
    } catch { /* treated as signed out below */ }
    if (!token) throw new ApiError('unauthenticated', 'Please sign in again.', 401);

    let res;
    try {
      res = await fetchFn(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body && { 'Content-Type': 'application/json' }) },
        body: body && JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ApiError('network', 'Cannot reach the server. Please try again.', 0, true);
    }

    const data = await res.json().catch(() => null);
    if (res.ok) return data;
    const uncertain = res.status >= 500 || typeof data?.error?.code !== 'string';
    if (res.status === 401) throw new ApiError('unauthenticated', 'Your session has expired. Please sign in again.', 401, uncertain);
    const message = USER_FACING.includes(res.status) && typeof data?.error?.message === 'string' ? data.error.message : GENERIC;
    throw new ApiError(data?.error?.code ?? 'error', message, res.status, uncertain);
  };
}

// Re-sends an idempotent request while its outcome is unknown. A definitive answer (success or a 4xx) stops the loop.
export async function retryUncertain(send, { attempts = 3, delayMs = 1000, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await send();
    } catch (err) {
      if (!err?.uncertain || i >= attempts) throw err;
      await wait(delayMs * i);
    }
  }
}

// firebase.js is loaded lazily so the client above can be unit-tested in Node (firebase.js imports from URLs).
export async function apiFetch(path, options) {
  const { auth } = await import('./firebase.js');
  let baseUrl;
  try {
    baseUrl = apiBaseFor(location.hostname, location.port);
  } catch (err) {
    console.error(err);
    throw new ApiError('unavailable', GENERIC);
  }
  return createApiClient({ getToken: () => auth.currentUser?.getIdToken(), baseUrl })(path, options);
}

// For people without an account (external approvers): same error handling, no Firebase and no token. The API's own
// messages are written for end users and are shown for every error it produces itself (an error envelope below 500).
export async function publicApi(path, { method = 'POST', body } = {}) {
  let baseUrl;
  try {
    baseUrl = apiBaseFor(location.hostname, location.port);
  } catch (err) {
    console.error(err);
    throw new ApiError('unavailable', GENERIC);
  }
  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ApiError('network', 'Cannot reach the server. Please try again.', 0, true);
  }
  const data = await res.json().catch(() => null);
  if (res.ok) return data;
  const own = typeof data?.error?.code === 'string' && res.status < 500;
  throw new ApiError(data?.error?.code ?? 'error', own && typeof data.error.message === 'string' ? data.error.message : GENERIC, res.status, !own);
}
