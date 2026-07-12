import { DomainSdkError, parseRetryAfter, redact } from "./errors";

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function readJson(response: Response): Promise<unknown> {
  const text = (await response.text()).slice(0, 16_000);
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DomainSdkError("REQUEST_FAILED", "The provider returned malformed JSON.", {
      statusCode: response.status,
      retryable: response.status >= 500,
      details: { response: text.slice(0, 1_000) },
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
