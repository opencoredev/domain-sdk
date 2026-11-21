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
  /^(?:(?:[a-z0-9]+[_-]){0,4}(?:x-)?(?:token|auth[_-]?token|auth[_-]?key|api[_-]?token|api[_-]?key|api[_-]?secret|secret[_-]?key|secret[_-]?api[_-]?key|secretapikey|secret[_-]?access[_-]?key|project[_-]?access[_-]?token|access[_-]?token|access[_-]?key|client[_-]?secret|refresh[_-]?token|session[_-]?token|id[_-]?token|authorization|basic[_-]?auth|auth|credentials|bearer|jwt|x-amz-signature|signature|secret|password|passwd|pwd|pass|private[_-]?key|cookie|set[_-]?cookie|session(?:[_-]?id)?)|[a-z][a-z0-9]{0,24}(?:Token|ApiKey|Secret|AccessKey|SecretKey|Password|Passwd|PrivateKey|Cookie|BasicAuth|Signature|Credentials|Bearer|Jwt))$/i;
const AUTH_SCHEME_PREFIX = /\b(Bearer|ApiKey|Basic|Digest|Token)(\s+|[:=][ \t]*)/gi;
const EXEMPT_AUTH_WORDS =
  /^(?:token|tokens|auth|authentication|authorization|header|headers|credentials|credential|required|missing|invalid|expired|revoked|denied|rejected|failed|error|format|type|value|mismatch|is|was|not|for|has|must|cannot|could|should|provided|supplied|used|the|this|that|you|your|ok|passed|true|false)$/i;
const URL_USERINFO_BARE =
  /(?<![a-z0-9+."'-])([a-z][a-z0-9+.-]{0,20}:(?:\\*\/){2})((?:\\+(?:\/|(?![/\\]))|[^/?#\s\\<>])+)@/gi;
const URL_USERINFO_DOUBLE_QUOTED =
  /(?<=")([a-z][a-z0-9+.-]{0,20}:(?:\\*\/){2})((?:\\+(?:[/"]|(?![/\\"]))|[^/?#\s\\"<>]|"(?=[^}\]:\s])(?!,\s*"))+)@/gi;
const URL_USERINFO_SINGLE_QUOTED =
  /(?<=')([a-z][a-z0-9+.-]{0,20}:(?:\\*\/){2})((?:\\+(?:[/']|(?![/\\']))|[^/?#\s\\'<>]|'(?=[^}\]:\s])(?!,\s*'))+)@/gi;
const INLINE_SECRET_PREFIX =
  /(?<![A-Za-z0-9])(?:(?:(?:x-)?(?:access[_-]?token|access[_-]?key|api[_-]?token|api[_-]?key|api[_-]?secret|secret[_-]?key|secret[_-]?api[_-]?key|secretapikey|secret[_-]?access[_-]?key|project[_-]?access[_-]?token|client[_-]?secret|refresh[_-]?token|session[_-]?token|id[_-]?token|auth[_-]?token|auth[_-]?key|authorization|basic[_-]?auth|x-amz-signature|signature|credentials|jwt|password|passwd|pwd|pass|private[_-]?key|set[_-]?cookie|cookie|session(?:[_-]?id)?|token|secret)|[a-z][a-z0-9]{0,24}(?:Token|ApiKey|Secret|AccessKey|SecretKey|Password|Passwd|PrivateKey|Cookie|BasicAuth|Signature|Credentials|Jwt))\\*["']?\s*(?:=|:|%3D)\s*|(?:(?:x-)?(?:access[_-]?token|access[_-]?key|api[_-]?token|api[_-]?key|api[_-]?secret|secret[_-]?key|secret[_-]?api[_-]?key|secret[_-]?access[_-]?key|client[_-]?secret|refresh[_-]?token|session[_-]?token|id[_-]?token|auth[_-]?token|auth[_-]?key|x-amz-signature|passwd|pwd|private[_-]?key)[ \t]+|password[ \t]+is[ \t]+))/gi;

function isShortBasicCredential(token: string): boolean {
  if (token.length < 4 || token.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(token)) {
    return false;
  }
  try {
    const raw = atob(token);
    if (raw.length < 2) return false;
    let hasColon = false;
    for (let i = 0; i < raw.length; i += 1) {
      const code = raw.charCodeAt(i);
      if (code === 0x3a) hasColon = true;
      if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return false;
    }
    return hasColon;
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
      while (index < value.length) {
        if (value.startsWith("[REDACTED]", index)) {
          index += "[REDACTED]".length;
          continue;
        }
        if (/[\s&,;)}\]]/.test(value[index]!)) break;
        index += 1;
      }
    }
  } else {
    while (index < value.length) {
      if (value.startsWith("[REDACTED]", index)) {
        index += "[REDACTED]".length;
        continue;
      }
      if (/[\s&,;)}\]]/.test(value[index]!)) break;
      index += 1;
    }
  }
  if (options.allowSecondToken && index < value.length) {
    while (index < value.length) {
      const sep = /^(?:[ \t,;]+|\r?\n[ \t]+)/.exec(value.slice(index));
      if (!sep) break;
      const next = index + sep[0].length;
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
      const digestLead = /^([A-Za-z_][A-Za-z0-9_-]*)(?=$|[\s.!?:,;)}\]])/.exec(
        value.slice(valueStart),
      );
      if (
        digestLead &&
        EXEMPT_AUTH_WORDS.test(digestLead[1]!) &&
        !/^[ \t]*=/.test(value.slice(valueStart + digestLead[1]!.length))
      ) {
        continue;
      }
      let inQuote: '"' | "'" | null = null;
      while (valueEnd < value.length) {
        const ch = value[valueEnd]!;
        if (inQuote !== null) {
          if (ch === "\\" && valueEnd + 1 < value.length) {
            valueEnd += 2;
            continue;
          }
          if (ch === inQuote) inQuote = null;
          valueEnd += 1;
          continue;
        }
        if (ch === '"' || ch === "'") {
          inQuote = ch;
          valueEnd += 1;
          continue;
        }
        if (ch === " " || ch === "\t") {
          if (/^[ \t]+(?:[a-z][a-z0-9+.-]{0,20}:\/\/|\[REDACTED\])/i.test(value.slice(valueEnd))) {
            break;
          }
        }
        if (ch === ";") {
          if (/^;\s*[A-Za-z_][A-Za-z0-9_-]*[ \t]*=/.test(value.slice(valueEnd))) {
            valueEnd += 1;
            continue;
          }
          break;
        }
        if (ch === "<" && valueEnd > valueStart && /^<\/[A-Za-z]/.test(value.slice(valueEnd))) {
          break;
        }
        if (ch === "}" || ch === "]") break;
        if (ch === "\r" || ch === "\n") {
          const cont = /^\r?\n[ \t]+/.exec(value.slice(valueEnd));
          if (cont) {
            valueEnd += cont[0].length;
            continue;
          }
          const paramCont = /^\r?\n\s*[A-Za-z_][A-Za-z0-9_-]*[ \t]*=/.test(value.slice(valueEnd));
          if (paramCont) {
            valueEnd += ch === "\r" && value[valueEnd + 1] === "\n" ? 2 : 1;
            continue;
          }
          break;
        }
        valueEnd += 1;
      }
    } else {
      const allowParams = lower === "token" || lower === "apikey";
      const isValueStop = (idx: number, from: number): boolean => {
        const ch = value[idx]!;
        if (
          lower === "basic" &&
          (ch === ";" || ch === ")" || ch === "," || ch === "\\") &&
          value.slice(from, idx).includes(":") &&
          idx + 1 < value.length &&
          !/[\s"'<]/.test(value[idx + 1]!)
        ) {
          return false;
        }
        if (/[\s"',;)}\]\\]/.test(ch)) return true;
        if ((ch === "&" || ch === "?") && /^[&?][A-Za-z_][A-Za-z0-9_-]*=/.test(value.slice(idx))) {
          return true;
        }
        if (ch === "<" && idx > from && /^<\/[A-Za-z]/.test(value.slice(idx))) {
          return true;
        }
        return false;
      };
      const scanAuthParam = (from: number): number => {
        if (allowParams || lower === "basic") {
          const paramPrefix = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*=(?!=)[ \t]*/.exec(
            value.slice(from),
          );
          if (paramPrefix && (allowParams || /^realm$/i.test(paramPrefix[1]!))) {
            const valStart = from + paramPrefix[0].length;
            if (
              valStart < value.length &&
              (value[valStart] === '"' ||
                value[valStart] === "'" ||
                (value[valStart] === "\\" && /^\\+"/.test(value.slice(valStart))))
            ) {
              return scanSecretValueEnd(value, valStart);
            }
            let unqEnd = valStart;
            while (unqEnd < value.length && !isValueStop(unqEnd, valStart)) {
              unqEnd += 1;
            }
            return unqEnd;
          }
        }
        let end = from;
        while (end < value.length && !isValueStop(end, from)) end += 1;
        return end;
      };
      valueEnd = scanAuthParam(valueStart);
      if (allowParams && value.slice(valueStart, valueEnd).includes("=")) {
        while (valueEnd < value.length) {
          const rest = value.slice(valueEnd);
          const sep =
            /^(?:[ \t]*[,;]\s*|\r?\n[ \t]*|[ \t]+)(?=[A-Za-z_][A-Za-z0-9_-]*[ \t]*=(?!=))/.exec(
              rest,
            );
          if (!sep) break;
          const nextEnd = scanAuthParam(valueEnd + sep[0].length);
          if (nextEnd <= valueEnd + sep[0].length) break;
          valueEnd = nextEnd;
        }
      }
      const token = value.slice(valueStart, valueEnd);
      const word = token.replace(/[.!?:]+$/, "");
      if (/^(?:bearer|basic|digest|apikey|token)$/i.test(word)) continue;
      const basicWord = word.startsWith("<") && word.endsWith(">") ? word.slice(1, -1) : word;
      if (
        (lower === "basic" &&
          (/^realm[ \t]*=/i.test(token) ||
            (!isShortBasicCredential(basicWord) &&
              (!/^(?:(?:[A-Za-z0-9+/=_~-]|%[0-9A-Fa-f]{2}){8,}|[^:\s=]*:[^\s]+)$/.test(basicWord) ||
                /^[A-Za-z]?[a-z]+$/.test(basicWord))))) ||
        ((lower === "bearer" || lower === "token") && EXEMPT_AUTH_WORDS.test(word))
      ) {
        continue;
      }
    }
    if (valueEnd === valueStart) continue;
    const rawSep = match[2]!;
    const outSep = /^\s+$/.test(rawSep) ? " " : rawSep;
    out += value.slice(cursor, match.index) + `${scheme}${outSep}[REDACTED]`;
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
    const rawVal = value.slice(valueStart, valueEnd);
    const quote = value[valueStart];
    if (
      quote !== '"' &&
      quote !== "'" &&
      quote !== "\\" &&
      /^(?:token|authorization|pass|password|passwd|pwd|signature|credentials|jwt)\s*(?:=|:|is\s+|\s+)\s*$/i.test(
        match[0],
      ) &&
      (EXEMPT_AUTH_WORDS.test(rawVal.replace(/[.!?:]+$/, "")) ||
        /^(?:bearer|basic|digest|apikey|token)$/i.test(rawVal.replace(/[.!?:]+$/, "")))
    ) {
      continue;
    }
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
