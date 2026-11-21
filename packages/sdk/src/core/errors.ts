export type DomainSdkErrorCode =
  | "AUTHENTICATION_FAILED"
  | "PERMISSION_DENIED"
  | "INVALID_CONFIGURATION"
  | "INVALID_HOSTNAME"
  | "DOMAIN_CONFLICT"
  | "DOMAIN_NOT_FOUND"
  | "UNSUPPORTED_OPERATION"
  | "VERIFICATION_FAILED"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "REQUEST_FAILED"
  | "TIMEOUT"
  | "ABORTED"
  | "UNKNOWN_ERROR";

export interface DomainSdkErrorOptions {
  provider?: string;
  statusCode?: number;
  retryable?: boolean;
  retryAfter?: number;
  details?: Record<string, unknown>;
  cause?: unknown;
}

const SECRET_KEYS =
  /^(?:[a-z0-9]+[_-]){0,4}(?:x-)?(token|auth[_-]?token|auth[_-]?key|api[_-]?token|api[_-]?key|api[_-]?secret|secret[_-]?key|secret[_-]?api[_-]?key|secretapikey|project[_-]?access[_-]?token|access[_-]?token|access[_-]?key|client[_-]?secret|refresh[_-]?token|authorization|secret|password|private[_-]?key)$/i;
const BEARER =
  /\b(?:(Bearer|ApiKey)\s+[^\s"',;)}\]\\]+|(Basic)\s+(?:[A-Za-z0-9+/=]{8,}|[^\s"',;)}\]\\]*:[^\s"',;)}\]\\]+)|(Token)\s+(?=[A-Za-z0-9._~+/=:-]*[\d_.:/+-])[^\s"',;)}\]\\]+)/gi;
const INLINE_SECRET_PREFIX =
  /(?<![A-Za-z0-9])(?:x-)?(?:access[_-]?token|access[_-]?key|api[_-]?token|api[_-]?key|api[_-]?secret|secret[_-]?key|secret[_-]?api[_-]?key|secretapikey|project[_-]?access[_-]?token|client[_-]?secret|refresh[_-]?token|auth[_-]?token|auth[_-]?key|authorization|password|private[_-]?key|token|secret)\\*["']?\s*(?:=|:)\s*/gi;
const MAX_STRING = 1_000;
const MAX_REDACT_DEPTH = 32;

function scanSecretValueEnd(value: string, start: number, allowSecondToken = false): number {
  if (start >= value.length) return start;
  if (value.startsWith("[REDACTED]", start)) return start + "[REDACTED]".length;
  const first = value[start];
  if (first === '"' || first === "'") {
    let index = start + 1;
    while (index < value.length) {
      if (value[index] === "\\") {
        index += 2;
        continue;
      }
      if (value[index] === first) return index + 1;
      index += 1;
    }
    return value.length;
  }
  if (first === "\\") {
    let slashes = 0;
    while (value[start + slashes] === "\\") slashes += 1;
    if (value[start + slashes] === '"') {
      let index = start + slashes + 1;
      const step = (slashes + 1) * 2;
      while (index < value.length) {
        if (value[index] === "\\") {
          let run = 0;
          while (value[index + run] === "\\") run += 1;
          if (value[index + run] === '"' && (run < slashes || (run - slashes) % step === 0))
            return index + run + 1;
          index += run + (value[index + run] === '"' ? 1 : 0);
          continue;
        }
        index += 1;
      }
      return value.length;
    }
  }
  let index = start;
  while (index < value.length && !/[\s&,;)}\]]/.test(value[index]!)) index += 1;
  if (allowSecondToken && index < value.length && /[ \t]/.test(value[index]!)) {
    let next = index;
    while (next < value.length && /[ \t]/.test(value[next]!)) next += 1;
    const tokenEnd = scanSecretValueEnd(value, next, false);
    if (tokenEnd > next) index = tokenEnd;
  }
  return index;
}

function scrubInlineSecrets(value: string): string {
  INLINE_SECRET_PREFIX.lastIndex = 0;
  let out = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_SECRET_PREFIX.exec(value)) !== null) {
    const valueStart = match.index + match[0].length;
    const isAuthHeader = /^(?:x-)?authorization\b/i.test(match[0]);
    const valueEnd = scanSecretValueEnd(value, valueStart, isAuthHeader);
    if (valueEnd === valueStart) continue;
    out += value.slice(cursor, valueStart) + "[REDACTED]";
    cursor = valueEnd;
    INLINE_SECRET_PREFIX.lastIndex = valueEnd;
  }
  return cursor === 0 ? value : out + value.slice(cursor);
}

function scrubString(value: string): string {
  return scrubInlineSecrets(
    value.replace(
      BEARER,
      (_match, a?: string, b?: string, c?: string) => `${a ?? b ?? c} [REDACTED]`,
    ),
  );
}

export function redact(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === "string") return scrubString(value).slice(0, MAX_STRING);
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_REDACT_DEPTH) return "[Truncated]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, seen, depth + 1));
  const safe: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, 50)) {
    safe[key] = SECRET_KEYS.test(key) ? "[REDACTED]" : redact(child, seen, depth + 1);
  }
  return safe;
}

/**
 * Copy a non-SDK error with its message and nested causes redacted, keeping its name, stack
 * frames, and a string or numeric `code` such as `ECONNRESET` so provider failures stay traceable.
 */
function redactedCause(cause: Error, seen = new WeakSet<object>(), depth = 0): Error {
  seen.add(cause);
  const message = String(redact(cause.message));
  let nested: unknown;
  if (cause.cause !== undefined) {
    if (depth >= MAX_REDACT_DEPTH) nested = "[Truncated]";
    else if (cause.cause instanceof DomainSdkError) nested = cause.cause;
    else if (cause.cause instanceof Error)
      nested = seen.has(cause.cause) ? "[Circular]" : redactedCause(cause.cause, seen, depth + 1);
    else nested = redact(cause.cause, seen, depth + 1);
  }
  const safe = nested !== undefined ? new Error(message, { cause: nested }) : new Error(message);
  safe.name = cause.name;
  const header = `${cause.name}: ${cause.message}`;
  const stack = cause.stack?.startsWith(header)
    ? `${cause.name}: ${message}${cause.stack.slice(header.length)}`
    : cause.stack;
  safe.stack = stack ? scrubString(stack) : stack;
  const code: unknown = Reflect.get(cause, "code");
  if (typeof code === "string" || typeof code === "number") Reflect.set(safe, "code", code);
  return safe;
}

export class DomainSdkError extends Error {
  readonly code: DomainSdkErrorCode;
  readonly provider?: string;
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly retryAfter?: number;
  readonly details?: Record<string, unknown>;
  override readonly cause?: unknown;

  constructor(code: DomainSdkErrorCode, message: string, options: DomainSdkErrorOptions = {}) {
    const safeCause =
      options.cause instanceof DomainSdkError
        ? options.cause
        : options.cause instanceof Error
          ? redactedCause(options.cause)
          : redact(options.cause);
    super(String(redact(message)), { cause: safeCause });
    this.name = "DomainSdkError";
    this.code = code;
    this.provider = options.provider;
    this.statusCode = options.statusCode;
    this.retryable = options.retryable ?? false;
    this.retryAfter = options.retryAfter;
    this.details = options.details
      ? (redact(options.details) as Record<string, unknown>)
      : undefined;
    this.cause = safeCause;
  }
}

export function abortedError(provider?: string, cause?: unknown) {
  return new DomainSdkError("ABORTED", "The domain operation was cancelled.", { provider, cause });
}

export function normalizeUnknownError(error: unknown, provider?: string): DomainSdkError {
  if (error instanceof DomainSdkError) return error;
  if ((error instanceof DOMException || error instanceof Error) && error.name === "AbortError")
    return abortedError(provider, error);
  return new DomainSdkError("UNKNOWN_ERROR", "The domain operation failed unexpectedly.", {
    provider,
    cause: error,
  });
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
