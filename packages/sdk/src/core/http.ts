import { abortedError, DomainSdkError, parseRetryAfter, redact } from "./errors";
import type { RetryOptions } from "./types";

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Parse a JSON response body. `maxLength` only bounds the preview kept in error details. */
export async function readJson(response: Response, maxLength = 16_000): Promise<unknown> {
  let rawText: string;
  try {
    rawText = await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new DomainSdkError("PROVIDER_UNAVAILABLE", "The provider response was interrupted.", {
      retryable: true,
      cause: error,
    });
  }
  if (!rawText) return undefined;
  try {
    return JSON.parse(rawText) as unknown;
  } catch {
    throw new DomainSdkError("REQUEST_FAILED", "The provider returned malformed JSON.", {
      statusCode: response.status,
      retryable: response.status >= 500,
      details: { response: rawText.slice(0, Math.min(maxLength, 1_000)) },
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

/** Wait `ms`, rejecting with `ABORTED` as soon as `signal` aborts. */
export const sleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortedError(undefined, signal.reason));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError(undefined, signal?.reason));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const RETRYABLE_STATUS = new Set([502, 503, 504]);

/** Whether an error is a transient rate limit or outage worth retrying. */
export function isTransientError(error: unknown): error is DomainSdkError {
  if (!(error instanceof DomainSdkError) || !error.retryable) return false;
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
          : Math.random() * Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      options.onRetry?.(error, attempt, delayMs);
      await wait(delayMs, options.signal);
    }
  }
}
