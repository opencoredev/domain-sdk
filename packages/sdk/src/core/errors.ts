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
  /^(token|api[_-]?token|api[_-]?key|authorization|secret|password|private[_-]?key)$/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const MAX_STRING = 1_000;

export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string")
    return value.replace(BEARER, "Bearer [REDACTED]").slice(0, MAX_STRING);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, seen));
  const safe: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, 50)) {
    safe[key] = SECRET_KEYS.test(key) ? "[REDACTED]" : redact(child, seen);
  }
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
          ? new Error(String(redact(options.cause.message)))
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
  if (error instanceof DOMException && error.name === "AbortError")
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
