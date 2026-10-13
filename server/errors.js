export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function notFound(req, res, next) {
  next(new HttpError(404, 'not-found', 'Not found.'));
}

// Only HttpError messages and body-parser failures reach the client; anything else is logged and hidden.
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  let { status, code, message } = err;
  if (!(err instanceof HttpError)) {
    if (err.type === 'entity.too.large') [status, code, message] = [413, 'payload-too-large', 'Request is too large.'];
    else if (err.type === 'entity.parse.failed') [status, code, message] = [400, 'invalid-json', 'Request body must be valid JSON.'];
    else if (Number.isInteger(err.status) && err.status >= 400 && err.status < 500) [status, code, message] = [err.status, 'bad-request', 'The request could not be processed.']; // e.g. a malformed percent-escape in the URL
    else {
      console.error(err);
      [status, code, message] = [500, 'internal', 'Something went wrong. Please try again later.'];
    }
  }
  if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
  res.status(status).json({ error: { code, message } });
}
