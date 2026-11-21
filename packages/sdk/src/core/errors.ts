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
  /^(?:(?:[a-z0-9]+[_-]){0,4}(?:x-)?(?:token|auth[_-]?token|auth[_-]?key|api[_-]?token|api[_-]?key|api[_-]?secret|secret[_-]?key|secret[_-]?api[_-]?key|secretapikey|secret[_-]?access[_-]?key|project[_-]?access[_-]?token|access[_-]?token|access[_-]?key|client[_-]?secret|refresh[_-]?token|session[_-]?token|id[_-]?token|authorization|secret|password|private[_-]?key|cookie|set[_-]?cookie|session(?:[_-]?id)?)|[a-z][a-z0-9]{0,24}(?:Token|ApiKey|Secret|AccessKey|SecretKey|Password|PrivateKey|Cookie))$/i;
const AUTH_SCHEME_PREFIX = /\b(Bearer|ApiKey|Basic|Digest|Token)[ \t]+/gi;
const EXEMPT_AUTH_WORDS =
  /^(?:token|tokens|auth|authentication|authorization|header|headers|credentials|credential|required|missing|invalid|expired|revoked|denied|rejected|failed|error|format|type|value|mismatch|is|was|not|for|has|must|cannot|could|should|provided|supplied|used|the|this|that|you|your)$/i;
const URL_USERINFO_BARE =
  /(?<![a-z0-9+."'-])([a-z][a-z0-9+.-]{0,20}:(?:\\*\/){2})((?:\\+(?:\/|(?![/\\]))|[^/?#\s\\<>])+)@/gi;
const URL_USERINFO_DOUBLE_QUOTED =
  /(?<=")([a-z][a-z0-9+.-]{0,20}:(?:\\*\/){2})((?:\\+(?:[/"]|(?![/\\"]))|[^/?#\s\\"<>]|"(?=[^}\]:\s])(?!,\s*"))+)@/gi;
const URL_USERINFO_SINGLE_QUOTED =
  /(?<=')([a-z][a-z0-9+.-]{0,20}:(?:\\*\/){2})((?:\\+(?:[/']|(?![/\\']))|[^/?#\s\\'<>]|'(?=[^}\]:\s])(?!,\s*'))+)@/gi;
const INLINE_SECRET_PREFIX =
  /(?<![A-Za-z0-9])(?:(?:x-)?(?:access[_-]?token|access[_-]?key|api[_-]?token|api[_-]?key|api[_-]?secret|secret[_-]?key|secret[_-]?api[_-]?key|secretapikey|secret[_-]?access[_-]?key|project[_-]?access[_-]?token|client[_-]?secret|refresh[_-]?token|session[_-]?token|id[_-]?token|auth[_-]?token|auth[_-]?key|authorization|password|private[_-]?key|set[_-]?cookie|cookie|session(?:[_-]?id)?|token|secret)|[a-z][a-z0-9]{0,24}(?:Token|ApiKey|Secret|AccessKey|SecretKey|Password|PrivateKey|Cookie))\\*["']?\s*(?:=|:)\s*/gi;

function isShortBasicCredential(token: string): boolean {
  if (token.length < 4 || token.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(token)) {
    return false;
  }
  try {
    const decoded = atob(token);
    return /^[\x20-\x7e]*:[\x20-\x7e]*$/.test(decoded) && decoded.length >= 2;
  } catch {
    return false;
  }
}
const MAX_STRING = 1_000;
const MAX_REDACT_DEPTH = 32;

function scanSecretValueEnd(
  value: string,
  start: number,
  options: { allowSecondToken?: boolean; includeSemicolons?: boolean } = {},
): number {
  if (start >= value.length) return start;
  let index = start;
  const first = value[start];
  if (value.startsWith("[REDACTED]", start)) {
    return start + "[REDACTED]".length;
  } else if (options.includeSemicolons) {
    while (index < value.length && !/[\r\n]/.test(value[index]!)) index += 1;
  } else if (first === '"' || first === "'") {
    index = start + 1;
    while (index < value.length) {
      if (value[index] === "\\") {
        index += 2;
        continue;
      }
      if (value[index] === first) {
        index += 1;
        break;
      }
      index += 1;
    }
  } else if (first === "\\") {
    let slashes = 0;
    while (value[start + slashes] === "\\") slashes += 1;
    if (value[start + slashes] === '"') {
      index = start + slashes + 1;
      const step = (slashes + 1) * 2;
      while (index < value.length) {
        if (value[index] === "\\") {
          let run = 0;
          while (value[index + run] === "\\") run += 1;
          if (value[index + run] === '"' && (run < slashes || (run - slashes) % step === 0)) {
            index = index + run + 1;
            break;
          }
          index += run + (value[index + run] === '"' ? 1 : 0);
          continue;
        }
        index += 1;
      }
    } else {
      while (index < value.length && !/[\s&,;)}\]]/.test(value[index]!)) index += 1;
    }
  } else {
    while (index < value.length && !/[\s&,;)}\]]/.test(value[index]!)) index += 1;
  }
  if (options.allowSecondToken && index < value.length && /[ \t]/.test(value[index]!)) {
    while (index < value.length && /[ \t,;]/.test(value[index]!)) {
      let next = index;
      while (next < value.length && /[ \t,;]/.test(value[next]!)) next += 1;
      const tokenEnd = scanSecretValueEnd(value, next);
      if (tokenEnd <= next) break;
      index = tokenEnd;
    }
  }
  return index;
}

function scrubAuthSchemes(value: string): string {
  AUTH_SCHEME_PREFIX.lastIndex = 0;
  let out = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = AUTH_SCHEME_PREFIX.exec(value)) !== null) {
    const scheme = match[1]!;
    const lower = scheme.toLowerCase();
    const valueStart = match.index + match[0].length;
    if (valueStart >= value.length) break;
    if (value.startsWith("[REDACTED]", valueStart)) {
      AUTH_SCHEME_PREFIX.lastIndex = valueStart + "[REDACTED]".length;
      continue;
    }
    const first = value[valueStart]!;
    let valueEnd = valueStart;
    if (
      first === '"' ||
      first === "'" ||
      (first === "\\" && /^\\+"/.test(value.slice(valueStart)))
    ) {
      valueEnd = scanSecretValueEnd(value, valueStart);
    } else if (lower === "digest") {
      while (valueEnd < value.length && !/[\r\n;}\]]/.test(value[valueEnd]!)) valueEnd += 1;
    } else {
      while (valueEnd < value.length && !/[\s"',;)}\]\\]/.test(value[valueEnd]!)) valueEnd += 1;
      const token = value.slice(valueStart, valueEnd);
      const word = token.replace(/[.!?:]+$/, "");
      if (/^(?:bearer|basic|digest|apikey|token)$/i.test(word)) continue;
      if (
        (lower === "basic" &&
          !isShortBasicCredential(token) &&
          (!/^(?:[A-Za-z0-9+/=]{8,}|[^:]*:[^:]+)$/.test(token) ||
            /^[A-Za-z]?[a-z]+$/.test(token))) ||
        ((lower === "bearer" || lower === "token") && EXEMPT_AUTH_WORDS.test(word))
      ) {
        continue;
      }
    }
    if (valueEnd === valueStart) continue;
    out += value.slice(cursor, match.index) + `${scheme} [REDACTED]`;
    cursor = valueEnd;
    AUTH_SCHEME_PREFIX.lastIndex = valueEnd;
  }
  return cursor === 0 ? value : out + value.slice(cursor);
}

function scrubInlineSecrets(value: string): string {
  INLINE_SECRET_PREFIX.lastIndex = 0;
  let out = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_SECRET_PREFIX.exec(value)) !== null) {
    const valueStart = match.index + match[0].length;
    const isAuthHeader = /^(?:x-)?authorization\s*:/i.test(match[0]);
    const isCookieHeader = /^(?:x-)?(?:set[_-]?)?cookie\s*:/i.test(match[0]);
    const valueEnd = scanSecretValueEnd(value, valueStart, {
      allowSecondToken: isAuthHeader,
      includeSemicolons: isCookieHeader,
    });
    if (valueEnd === valueStart) continue;
    const quote = value[valueStart];
    const quotedJsonValue =
      (quote === '"' || quote === "'") &&
      value[valueEnd - 1] === quote &&
      /["']\s*(?:=|:)\s*$/.test(match[0]);
    out += quotedJsonValue
      ? `${value.slice(cursor, valueStart + 1)}[REDACTED]${quote}`
      : `${value.slice(cursor, valueStart)}[REDACTED]`;
    cursor = valueEnd;
    INLINE_SECRET_PREFIX.lastIndex = valueEnd;
  }
  return cursor === 0 ? value : out + value.slice(cursor);
}

function scrubString(value: string, depth = 0): string {
  if (depth < MAX_REDACT_DEPTH && /^[\s]*["{[]/.test(value)) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string" || (parsed !== null && typeof parsed === "object")) {
        return JSON.stringify(redact(parsed, new WeakSet<object>(), depth + 1));
      }
    } catch {
      // Non-JSON diagnostics still use the text scanner below.
    }
  }
  const scrubUserinfo = (_match: string, scheme: string, userinfo: string) => {
    if (userinfo === "[REDACTED]" || userinfo === "[REDACTED]:[REDACTED]") {
      return `${scheme}${userinfo}@`;
    }
    return userinfo.includes(":") ? `${scheme}[REDACTED]:[REDACTED]@` : `${scheme}[REDACTED]@`;
  };
  const withoutUserinfo = value.includes("@")
    ? value
        .replace(URL_USERINFO_DOUBLE_QUOTED, scrubUserinfo)
        .replace(URL_USERINFO_SINGLE_QUOTED, scrubUserinfo)
        .replace(URL_USERINFO_BARE, scrubUserinfo)
    : value;
  return scrubInlineSecrets(scrubAuthSchemes(withoutUserinfo));
}

function safeRead(target: object, key: string): unknown {
  try {
    return Reflect.get(target, key);
  } catch {
    return undefined;
  }
}

export function safeInstanceOf<T>(
  value: unknown,
  ctor: abstract new (...args: never[]) => T,
): value is T {
  try {
    return value instanceof ctor;
  } catch {
    return false;
  }
}

function safeString(value: unknown): string {
  try {
    return String(value ?? "");
  } catch {
    return "[Unreadable]";
  }
}

function setDataProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function redact(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === "string") return scrubString(value, depth).slice(0, MAX_STRING);
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_REDACT_DEPTH) return "[Truncated]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    return "[Unreadable]";
  }
  if (isArray) {
    try {
      return (value as unknown[]).slice(0, 50).map((item) => redact(item, seen, depth + 1));
    } catch {
      return "[Unreadable]";
    }
  }
  let keys: string[];
  try {
    keys = Object.keys(value).slice(0, 50);
  } catch {
    return "[Unreadable]";
  }
  const safe: Record<string, unknown> = {};
  for (const key of keys) {
    if (SECRET_KEYS.test(key)) {
      setDataProperty(safe, key, "[REDACTED]");
      continue;
    }
    let child: unknown;
    try {
      child = Reflect.get(value, key);
    } catch {
      setDataProperty(safe, key, "[Unreadable]");
      continue;
    }
    setDataProperty(safe, key, redact(child, seen, depth + 1));
  }
  return safe;
}

/**
 * Copy a non-SDK error with its message and nested causes redacted, keeping its name, stack
 * frames, and a string or numeric `code` such as `ECONNRESET` so provider failures stay traceable.
 */
function redactedCause(cause: Error, seen = new WeakSet<object>(), depth = 0): Error {
  seen.add(cause);
  const rawMessage = safeRead(cause, "message");
  const rawName = safeRead(cause, "name");
  const rawStack = safeRead(cause, "stack");
  const rawNested = safeRead(cause, "cause");
  const messageText = typeof rawMessage === "string" ? rawMessage : safeString(rawMessage);
  const nameText = typeof rawName === "string" ? rawName : "Error";
  const message = String(redact(messageText));
  let nested: unknown;
  if (rawNested !== undefined) {
    if (depth >= MAX_REDACT_DEPTH) nested = "[Truncated]";
    else if (safeInstanceOf(rawNested, DomainSdkError)) nested = rawNested;
    else if (safeInstanceOf(rawNested, Error))
      nested = seen.has(rawNested) ? "[Circular]" : redactedCause(rawNested, seen, depth + 1);
    else nested = redact(rawNested, seen, depth + 1);
  }
  const safe = nested !== undefined ? new Error(message, { cause: nested }) : new Error(message);
  safe.name = scrubString(nameText);
  if (typeof rawStack === "string") {
    const header = `${nameText}: ${messageText}`;
    const stack = rawStack.startsWith(header)
      ? `${safe.name}: ${message}${rawStack.slice(header.length)}`
      : rawStack;
    safe.stack = scrubString(stack);
  } else {
    safe.stack = undefined;
  }
  const code = safeRead(cause, "code");
  if (typeof code === "string") Reflect.set(safe, "code", scrubString(code));
  else if (typeof code === "number") Reflect.set(safe, "code", code);
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
    const safeCause = safeInstanceOf(options.cause, DomainSdkError)
      ? options.cause
      : safeInstanceOf(options.cause, Error)
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
  if (safeInstanceOf(error, DomainSdkError)) return error;
  if (
    ((typeof DOMException === "function" && safeInstanceOf(error, DOMException)) ||
      safeInstanceOf(error, Error)) &&
    safeRead(error, "name") === "AbortError"
  )
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
