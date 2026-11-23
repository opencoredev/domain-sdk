import { abortedError, DomainSdkError, parseRetryAfter, redact, safeInstanceOf } from "./errors";
import type { RetryOptions } from "./types";

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Largest response body `readJson()` buffers by default: 8 MiB. */
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const oversizedResponses = new WeakSet<DomainSdkError>();

function responseTooLarge(response: Response, maxBytes: number, provider?: string): DomainSdkError {
  const error = new DomainSdkError(
    "REQUEST_FAILED",
    `The provider response is larger than ${maxBytes} bytes.`,
    { provider, statusCode: response.status, details: { maxBytes } },
  );
  oversizedResponses.add(error);
  return error;
}

/** Whether `readJson()` rejected a body for exceeding its byte cap. */
export function isResponseTooLarge(error: unknown): error is DomainSdkError {
  return safeInstanceOf(error, DomainSdkError) && oversizedResponses.has(error);
}

/** Read a response body as text, refusing to buffer more than `maxBytes`. */
async function readText(response: Response, maxBytes: number, provider?: string): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw responseTooLarge(response, maxBytes, provider);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        void reader.cancel().catch(() => {});
        throw responseTooLarge(response, maxBytes, provider);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

export function isAbortError(error: unknown): boolean {
  try {
    return (
      (error instanceof Error ||
        (typeof DOMException === "function" && error instanceof DOMException)) &&
      error.name === "AbortError"
    );
  } catch {
    return false;
  }
}

/**
 * Parse a JSON response body. Bodies over `maxBytes` (8 MiB by default) are cancelled and
 * rejected with `REQUEST_FAILED` instead of being buffered into memory.
 */
export async function readJson(
  response: Response,
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
  provider?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  let rawText: string;
  try {
    rawText = await readText(response, maxBytes, provider);
  } catch (error) {
    if (safeInstanceOf(error, DomainSdkError)) throw error;
    if (signal?.aborted) throw abortedError(provider, signal.reason ?? error);
    if (isAbortError(error)) throw abortedError(provider, error);
    throw new DomainSdkError("PROVIDER_UNAVAILABLE", "The provider response was interrupted.", {
      provider,
      retryable: true,
      cause: error,
    });
  }
  if (!rawText) return undefined;
  try {
    return JSON.parse(rawText) as unknown;
  } catch {
    throw new DomainSdkError("REQUEST_FAILED", "The provider returned malformed JSON.", {
      provider,
      statusCode: response.status,
      retryable: response.status >= 500,
      details: { response: redact(rawText) },
    });
  }
}

export function httpError(
  provider: string,
  response: Response,
  body: unknown,
  fallback: string,
): DomainSdkError {
  const object = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const nested =
    object.error && typeof object.error === "object"
      ? (object.error as Record<string, unknown>)
      : object;
  const message = typeof nested.message === "string" ? nested.message : fallback;
  const providerCode =
    typeof nested.code === "string" || typeof nested.code === "number"
      ? String(nested.code)
      : undefined;
  const status = response.status;
  let code: import("./errors").DomainSdkErrorCode = "REQUEST_FAILED";
  if (status === 401) code = "AUTHENTICATION_FAILED";
  else if (status === 403) code = "PERMISSION_DENIED";
  else if (status === 404) code = "DOMAIN_NOT_FOUND";
  else if (status === 409) code = "DOMAIN_CONFLICT";
  else if (status === 429) code = "RATE_LIMITED";
  else if (status >= 500) code = "PROVIDER_UNAVAILABLE";
  return new DomainSdkError(code, `${provider} request failed: ${message}`, {
    provider,
    statusCode: status,
    retryable: status === 408 || status === 429 || status >= 500,
    retryAfter: parseRetryAfter(response.headers.get("retry-after")),
    details: { providerCode, response: redact(body) },
  });
}

export function requireString(value: string | undefined, name: string, provider: string): string {
  if (!value?.trim())
    throw new DomainSdkError("INVALID_CONFIGURATION", `${provider} requires ${name}.`, {
      provider,
    });
  return value;
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

const MAX_TIMER_MS = 2_147_483_647;

/** Wait `ms`, rejecting with `ABORTED` as soon as `signal` aborts. Splits waits above the 32-bit timer cap. */
export const sleep: Sleep = async (ms, signal) => {
  if (signal?.aborted) throw abortedError(undefined, signal.reason);
  let remaining = Math.max(0, ms);
  while (remaining > 0) {
    const step = Math.min(remaining, MAX_TIMER_MS);
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(abortedError(undefined, signal.reason));
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortedError(undefined, signal?.reason));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, step);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    remaining -= step;
  }
};

const RETRYABLE_STATUS = new Set([502, 503, 504]);

/**
 * Whether the host answered a write with a 4xx status, so it definitely applied nothing. A
 * failure with no answer, a 5xx, or a 2xx whose body could not be read may still have applied.
 */
export function rejectedByHost(error: unknown): boolean {
  if (!safeInstanceOf(error, DomainSdkError)) return false;
  const status = error.statusCode;
  return status !== undefined && status >= 400 && status < 500;
}

/** Whether an error is a transient rate limit or outage worth retrying. */
export function isTransientError(error: unknown): error is DomainSdkError {
  if (!safeInstanceOf(error, DomainSdkError) || !error.retryable) return false;
  if (error.code === "RATE_LIMITED") return true;
  if (error.code === "PROVIDER_UNAVAILABLE")
    return error.statusCode === undefined || RETRYABLE_STATUS.has(error.statusCode);
  // A non-JSON outage page, such as a proxy's HTML 503, fails parsing before status mapping.
  return (
    error.code === "REQUEST_FAILED" &&
    error.statusCode !== undefined &&
    RETRYABLE_STATUS.has(error.statusCode)
  );
}

export interface WithRetryOptions {
  retry?: RetryOptions;
  signal?: AbortSignal;
  sleep?: Sleep;
  /** Extra veto for errors that are transient but unsafe to repeat. */
  shouldRetry?(error: DomainSdkError): boolean;
  onRetry?(error: DomainSdkError, attempt: number, delayMs: number): void;
}

/**
 * Run `operation`, retrying rate limits and 502/503/504 or network failures. Waits the
 * provider's `Retry-After` when it sent one, otherwise exponential backoff with full jitter;
 * every wait is capped at `maxDelayMs`.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: WithRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.retry?.maxAttempts ?? 3;
  const baseDelayMs = options.retry?.baseDelayMs ?? 250;
  const maxDelayMs = options.retry?.maxDelayMs ?? 10_000;
  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    !(baseDelayMs >= 0 && Number.isFinite(baseDelayMs)) ||
    !(maxDelayMs >= 0 && Number.isFinite(maxDelayMs))
  )
    throw new DomainSdkError(
      "INVALID_CONFIGURATION",
      "retry.maxAttempts must be a positive integer and retry delays must be non-negative.",
    );
  const wait = options.sleep ?? sleep;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (
        attempt >= maxAttempts ||
        options.signal?.aborted ||
        !isTransientError(error) ||
        options.shouldRetry?.(error) === false
      )
        throw error;
      const delayMs =
        error.retryAfter !== undefined
          ? Math.min(error.retryAfter, maxDelayMs)
          : baseDelayMs === 0
            ? 0
            : Math.random() * Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      options.onRetry?.(error, attempt, delayMs);
      await wait(delayMs, options.signal);
    }
  }
}
