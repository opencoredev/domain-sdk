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
  /^(?:(?:[a-z0-9]+[_-]){0,4}(?:x-)?(?:token|auth[_-]?token|auth[_-]?key|api[_-]?token|api[_-]?key|api[_-]?secret|secret[_-]?key|secret[_-]?api[_-]?key|secretapikey|secret[_-]?access[_-]?key|project[_-]?access[_-]?token|access[_-]?token|access[_-]?key(?:[_-]?id)?|client[_-]?secret|refresh[_-]?token|session[_-]?token|id[_-]?token|authorization|basic[_-]?auth|auth|credentials|bearer|jwt|x-amz-signature|signature|secret|password|passwd|pwd|pass|passphrase|private[_-]?key|cookie|set[_-]?cookie|session(?:[_-]?id)?)|[a-z][a-z0-9]{0,24}(?:Token|ApiKey|Secret|AccessKey(?:Id)?|SecretKey|Password|Passwd|PrivateKey|Cookie|BasicAuth|Signature|Credentials|Bearer|Jwt))$/i;
const AUTH_SCHEME_PREFIX =
  /\b(Bearer|ApiKey|Basic|Digest|Token)(\s+|\+|%20|%09|[:=](?:[ \t]|%20|%09)*|%3A(?:[ \t]|%20|%09)*|%3D(?:[ \t]|%20|%09)*)/gi;
const AUTH_PARAM_PREFIX =
  /\b(?:response|nonce|cnonce|opaque)(?:[ \t]|%20|%09)*(?:=|%3D)(?:[ \t]|%20|%09)*/gi;
const EXEMPT_AUTH_WORDS =
  /^(?:token|tokens|auth|authentication|authorization|header|headers|credentials|credential|required|missing|invalid|expired|revoked|denied|rejected|failed|error|format|type|value|mismatch|is|was|not|for|of|bucket|has|must|cannot|could|should|provided|supplied|used|the|this|that|you|your|ok|passed|true|false)$/i;
const URL_USERINFO_BARE =
  /(?<![a-z0-9+."'-])([a-z][a-z0-9+.-]{0,20}:(?:\\*\/){2})((?:\\+(?:\/|(?![/\\]))|[^/?#\s\\<>])+)@/gi;
const URL_USERINFO_DOUBLE_QUOTED =
  /(?<=")([a-z][a-z0-9+.-]{0,20}:(?:\\*\/){2})((?:\\+(?:[/"]|(?![/\\"]))|[^/?#\s\\"<>]|"(?=[^}\]:\s])(?!,\s*"))+)@/gi;
const URL_USERINFO_SINGLE_QUOTED =
  /(?<=')([a-z][a-z0-9+.-]{0,20}:(?:\\*\/){2})((?:\\+(?:[/']|(?![/\\']))|[^/?#\s\\'<>]|'(?=[^}\]:\s])(?!,\s*'))+)@/gi;
const INLINE_SECRET_PREFIX =
  /(?<![A-Za-z0-9])(?:(?:(?:x-)?(?:access[_-]?token|access[_-]?key(?:[_-]?id)?|api[_-]?token|api[_-]?key|api[ \t]+key|api[_-]?secret|secret[_-]?key|secret[_-]?api[_-]?key|secretapikey|secret[_-]?access[_-]?key|project[_-]?access[_-]?token|client[_-]?secret|refresh[_-]?token|session[_-]?token|id[_-]?token|auth[_-]?token|auth[_-]?key|authorization|basic[_-]?auth|basic|digest|auth|bearer|x-amz-signature|signature|credentials|jwt|password|passwd|pwd|pass|passphrase|private[_-]?key|set[_-]?cookie|cookie|session(?:[_-]?id)?|token|secret)|[a-z][a-z0-9]{0,24}(?:Token|ApiKey|Secret|AccessKey(?:Id)?|SecretKey|Password|Passwd|PrivateKey|Cookie|BasicAuth|Signature|Credentials|Jwt))\\*["']?\s*(?::=|=|:|%3D|%3A)(?:\s|%20|%09)*|(?:(?:x-)?(?:access[_-]?token|access[_-]?key(?:[_-]?id)?|api[_-]?token|api[_-]?key|api[ \t]+key|api[_-]?secret|secret[_-]?key|secret[_-]?api[_-]?key|secret[_-]?access[_-]?key|client[_-]?secret|refresh[_-]?token|session[_-]?token|id[_-]?token|auth[_-]?token|auth[_-]?key|x-amz-signature|password|passwd|pwd|passphrase|private[_-]?key|secret)[ \t]+|(?:password|passphrase|secret)[ \t]+is[ \t]+))/gi;

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
      const sep = /^(?:[ \t,;]+|\r?\n[ \t]+)/.exec(value.slice(index, index + 64));
      if (!sep) break;
      const next = index + sep[0].length;
      const tokenEnd = scanSecretValueEnd(value, next);
      if (tokenEnd <= next) break;
      index = tokenEnd;
    }
  }
  return index;
}

function looksLikeTrailingCredential(
  token: string,
  mode: "basic" | "generic",
  wasQuoted = false,
): boolean {
  const unwrapped =
    (token.startsWith("<") && token.endsWith(">")) ||
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
      ? token.slice(1, -1)
      : token;
  if (unwrapped.length === 0 || EXEMPT_AUTH_WORDS.test(unwrapped)) return false;
  if (wasQuoted) return true;
  if (mode === "basic") {
    return (
      isShortBasicCredential(unwrapped) ||
      (/^(?:(?:[A-Za-z0-9+/=_~-]|%[0-9A-Fa-f]{2}){8,}|[^:\s=]*:[^\s]+)$/.test(unwrapped) &&
        !/^[A-Za-z]?[a-z]+$/.test(unwrapped))
    );
  }
  return (
    unwrapped.length >= 6 &&
    !/^[A-Za-z]?[a-z]+$/.test(unwrapped) &&
    /(?:[0-9_/:+=-]|^[A-Z]{2,}|[a-z][A-Z])/.test(unwrapped)
  );
}

function scanTrailingCredential(
  value: string,
  start: number,
  lineEnd: number,
  mode: "basic" | "generic",
  scanToken: (from: number) => number,
): { start: number; end: number } | null {
  let scan = start;
  let steps = 0;
  while (scan < lineEnd && steps < 6) {
    steps += 1;
    const gap = /^(?:[,:;]?[ \t]+)/.exec(value.slice(scan, Math.min(lineEnd, scan + 32)));
    if (!gap) break;
    const tokStart = scan + gap[0].length;
    if (tokStart >= lineEnd) break;
    const ch = value[tokStart]!;
    const isQuoted =
      ch === '"' ||
      ch === "'" ||
      (ch === "\\" && /^\\+"/.test(value.slice(tokStart, tokStart + 8)));
    if (isQuoted) {
      const tokEnd = Math.min(lineEnd, scanSecretValueEnd(value, tokStart));
      if (tokEnd <= tokStart) break;
      const rawTok = value.slice(tokStart, tokEnd).replace(/^\\+"|\\+"$/g, '"');
      return looksLikeTrailingCredential(rawTok, mode, true)
        ? { start: tokStart, end: tokEnd }
        : null;
    }
    const peek = value.slice(tokStart, Math.min(lineEnd, tokStart + 64));
    // Stop before another auth scheme or key=value auth parameter so dedicated passes handle them.
    if (
      /^(?:Bearer|ApiKey|Basic|Digest|Token)(?:\s|%20|%09|[:=]|%3A|%3D)/i.test(peek) ||
      /^[A-Za-z_][A-Za-z0-9_-]*(?:[ \t]|%20|%09)*(?:=|%3D)/i.test(peek)
    ) {
      break;
    }
    const tokEnd = Math.min(lineEnd, scanToken(tokStart));
    if (tokEnd <= tokStart) break;
    const rawTok = value.slice(tokStart, tokEnd);
    const cleanTok = rawTok.replace(/[.!?:]+$/, "");
    if (EXEMPT_AUTH_WORDS.test(cleanTok)) {
      scan = tokEnd;
      continue;
    }
    return looksLikeTrailingCredential(cleanTok, mode, false)
      ? { start: tokStart, end: tokEnd }
      : null;
  }
  return null;
}

function scrubAuthSchemes(value: string): string {
  AUTH_SCHEME_PREFIX.lastIndex = 0;
  let out = "";
  let cursor = 0;
  let nextNL = 0;
  let nextCR = 0;
  const getLineEnd = (pos: number): number => {
    if (nextNL !== -1 && nextNL < pos) nextNL = value.indexOf("\n", pos);
    if (nextCR !== -1 && nextCR < pos) nextCR = value.indexOf("\r", pos);
    return nextNL === -1
      ? nextCR === -1
        ? value.length
        : nextCR
      : nextCR === -1
        ? nextNL
        : Math.min(nextNL, nextCR);
  };
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
    // Spaced key/value assignments like `token = "secret"`, `token : "secret"`, `token := secret`,
    // or `token %3D secret` belong to scrubInlineSecrets.
    if (
      /^\s+$/.test(match[2]!) &&
      (first === "=" ||
        (first === ":" &&
          (value[valueStart + 1] === "=" ||
            value[valueStart + 1] === " " ||
            value[valueStart + 1] === "\t")) ||
        /^%(?:3A|3D)/i.test(value.slice(valueStart, valueStart + 3)))
    ) {
      continue;
    }
    let valueEnd = valueStart;
    if (
      first === '"' ||
      first === "'" ||
      (first === "\\" && /^\\+"/.test(value.slice(valueStart, valueStart + 8)))
    ) {
      valueEnd = scanSecretValueEnd(value, valueStart);
    } else if (lower === "digest") {
      const digestLead = /^([A-Za-z_][A-Za-z0-9_-]*)(?=$|[\s.!?:,;)}\]])/.exec(
        value.slice(valueStart, valueStart + 64),
      );
      if (
        digestLead &&
        !/^[A-Z]{4,}$/.test(digestLead[1]!) &&
        EXEMPT_AUTH_WORDS.test(digestLead[1]!) &&
        !/^(?:[ \t]|%20|%09)*(?:=|%3D)/i.test(
          value.slice(valueStart + digestLead[1]!.length, valueStart + digestLead[1]!.length + 16),
        )
      ) {
        const leadEnd = valueStart + digestLead[1]!.length;
        const trailing = scanTrailingCredential(
          value,
          leadEnd,
          getLineEnd(leadEnd),
          "generic",
          (from) => scanSecretValueEnd(value, from),
        );
        if (trailing) {
          out += `${value.slice(cursor, trailing.start)}[REDACTED]`;
          cursor = trailing.end;
          AUTH_SCHEME_PREFIX.lastIndex = trailing.end;
        }
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
          if (
            /^[ \t]+(?:[a-z][a-z0-9+.-]{0,20}:\/\/|\[REDACTED\])/i.test(
              value.slice(valueEnd, valueEnd + 48),
            )
          ) {
            break;
          }
        }
        if (ch === ";") {
          if (/^;\s*[A-Za-z_][A-Za-z0-9_-]*[ \t]*=/.test(value.slice(valueEnd, valueEnd + 64))) {
            valueEnd += 1;
            continue;
          }
          break;
        }
        if (
          ch === "<" &&
          valueEnd > valueStart &&
          /^<\/[A-Za-z]/.test(value.slice(valueEnd, valueEnd + 8))
        ) {
          break;
        }
        if (ch === "}" || ch === "]") break;
        if (ch === "\r" || ch === "\n") {
          const slice = value.slice(valueEnd, valueEnd + 64);
          const cont = /^\r?\n[ \t]+/.exec(slice);
          if (cont) {
            valueEnd += cont[0].length;
            continue;
          }
          const paramCont = /^\r?\n\s*[A-Za-z_][A-Za-z0-9_-]*[ \t]*=/.test(slice);
          if (paramCont) {
            valueEnd += ch === "\r" && value[valueEnd + 1] === "\n" ? 2 : 1;
            continue;
          }
          break;
        }
        valueEnd += 1;
      }
    } else {
      const allowParams = lower === "token" || lower === "apikey" || lower === "bearer";
      const opener = match.index > 0 ? value[match.index - 1] : undefined;
      const enclosingQuote = opener === '"' || opener === "'" ? opener : undefined;
      let failedDelimEnd = -1;
      const isTrailingClosingDelims = (startIdx: number): boolean => {
        if (startIdx < failedDelimEnd) return false;
        let p = startIdx;
        while (
          p < value.length &&
          (value[p] === "," || value[p] === "}" || value[p] === "]" || value[p] === ")")
        ) {
          p += 1;
        }
        const ok = p >= value.length || /[\s<]/.test(value[p]!);
        if (!ok) failedDelimEnd = p;
        return ok;
      };
      const isValueStop = (idx: number, from: number, hasColon: boolean): boolean => {
        const ch = value[idx]!;
        if (lower === "basic") {
          if (enclosingQuote !== undefined && ch === enclosingQuote) {
            let backslashes = 0;
            let b = idx - 1;
            while (b >= from && value[b] === "\\") {
              backslashes += 1;
              b -= 1;
            }
            if (backslashes % 2 === 0) return true;
          }
          if (hasColon && /[;,)}\]"'\\]/.test(ch)) {
            if (idx + 1 >= value.length || /[\s<]/.test(value[idx + 1]!)) return true;
            if (
              (ch === "," || ch === "}" || ch === "]" || ch === ")") &&
              isTrailingClosingDelims(idx + 1)
            ) {
              return true;
            }
            return false;
          }
          if (!hasColon && ch === "|") return true;
        }
        if (/[\s"',;)}\]\\]/.test(ch)) return true;
        if (
          (ch === "&" || ch === "?") &&
          /^[&?][A-Za-z_][A-Za-z0-9_-]*=/.test(value.slice(idx, idx + 64))
        ) {
          return true;
        }
        if (ch === "<" && idx > from && /^<\/[A-Za-z]/.test(value.slice(idx, idx + 8))) {
          return true;
        }
        return false;
      };
      const scanAuthParam = (from: number): number => {
        if (allowParams || lower === "basic") {
          const paramPrefix = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*=(?!=)[ \t]*/.exec(
            value.slice(from, from + 64),
          );
          if (paramPrefix && (allowParams || /^realm$/i.test(paramPrefix[1]!))) {
            const valStart = from + paramPrefix[0].length;
            if (
              valStart < value.length &&
              (value[valStart] === '"' ||
                value[valStart] === "'" ||
                (value[valStart] === "\\" && /^\\+"/.test(value.slice(valStart, valStart + 8))))
            ) {
              return scanSecretValueEnd(value, valStart);
            }
            let unqEnd = valStart;
            let hasColon = false;
            while (unqEnd < value.length && !isValueStop(unqEnd, valStart, hasColon)) {
              if (value[unqEnd] === ":") hasColon = true;
              unqEnd += 1;
            }
            return unqEnd;
          }
        }
        let end = from;
        let hasColon = false;
        while (end < value.length && !isValueStop(end, from, hasColon)) {
          if (value[end] === ":") hasColon = true;
          end += 1;
        }
        return end;
      };
      valueEnd = scanAuthParam(valueStart);
      if (allowParams && value.slice(valueStart, valueEnd).includes("=")) {
        while (valueEnd < value.length) {
          const rest = value.slice(valueEnd, valueEnd + 64);
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
      const isAllCaps = /^[A-Z]{4,}$/.test(word);
      const restAfterWord = value.slice(valueEnd, Math.min(getLineEnd(valueEnd), valueEnd + 32));
      if (
        !isAllCaps &&
        /^(?:bearer|basic|digest|apikey|token)$/i.test(word) &&
        /^(?:[ \t]*[=:]|[ \t]+[a-z])/.test(restAfterWord)
      ) {
        continue;
      }
      const basicWord = word.startsWith("<") && word.endsWith(">") ? word.slice(1, -1) : word;
      if (
        (lower === "basic" &&
          (/^realm[ \t]*=/i.test(token) ||
            (!isShortBasicCredential(basicWord) &&
              (!/^(?:(?:[A-Za-z0-9+/=_~-]|%[0-9A-Fa-f]{2}){8,}|[^:\s=]*:[^\s]+)$/.test(basicWord) ||
                /^[A-Za-z]?[a-z]+$/.test(basicWord))))) ||
        ((lower === "bearer" || lower === "token" || lower === "apikey") &&
          !isAllCaps &&
          EXEMPT_AUTH_WORDS.test(word))
      ) {
        const trailing = scanTrailingCredential(
          value,
          valueEnd,
          getLineEnd(valueEnd),
          lower === "basic" ? "basic" : "generic",
          scanAuthParam,
        );
        if (trailing) {
          out += `${value.slice(cursor, trailing.start)}[REDACTED]`;
          cursor = trailing.end;
          AUTH_SCHEME_PREFIX.lastIndex = trailing.end;
        }
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

function scrubAuthParams(value: string): string {
  AUTH_PARAM_PREFIX.lastIndex = 0;
  let out = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = AUTH_PARAM_PREFIX.exec(value)) !== null) {
    const valueStart = match.index + match[0].length;
    if (valueStart >= value.length) break;
    if (value.startsWith("[REDACTED]", valueStart)) {
      AUTH_PARAM_PREFIX.lastIndex = valueStart + "[REDACTED]".length;
      continue;
    }
    const valueEnd = scanSecretValueEnd(value, valueStart);
    if (valueEnd <= valueStart) continue;
    out += `${value.slice(cursor, valueStart)}[REDACTED]`;
    cursor = valueEnd;
    AUTH_PARAM_PREFIX.lastIndex = valueEnd;
  }
  return cursor === 0 ? value : out + value.slice(cursor);
}

function scrubInlineSecrets(value: string): string {
  INLINE_SECRET_PREFIX.lastIndex = 0;
  let out = "";
  let cursor = 0;
  let nextNL = 0;
  let nextCR = 0;
  const getLineEnd = (pos: number): number => {
    if (nextNL !== -1 && nextNL < pos) nextNL = value.indexOf("\n", pos);
    if (nextCR !== -1 && nextCR < pos) nextCR = value.indexOf("\r", pos);
    return nextNL === -1
      ? nextCR === -1
        ? value.length
        : nextCR
      : nextCR === -1
        ? nextNL
        : Math.min(nextNL, nextCR);
  };
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
    const cleanVal = rawVal.replace(/[.!?:]+$/, "");
    const isBareSecretOrPassword = /^(?:secret|password|passphrase)[ \t]+$|^basic\s*:\s*$/i.test(
      match[0],
    );
    const isAllCapsVal = /^[A-Z]{4,}$/.test(cleanVal);
    if (
      quote !== '"' &&
      quote !== "'" &&
      quote !== "\\" &&
      !isAllCapsVal &&
      EXEMPT_AUTH_WORDS.test(cleanVal)
    ) {
      const trailing = scanTrailingCredential(
        value,
        valueEnd,
        getLineEnd(valueEnd),
        /^basic\b/i.test(match[0]) ? "basic" : "generic",
        (from) => scanSecretValueEnd(value, from),
      );
      if (trailing) {
        out += `${value.slice(cursor, trailing.start)}[REDACTED]`;
        cursor = trailing.end;
        INLINE_SECRET_PREFIX.lastIndex = trailing.end;
        continue;
      }
    }
    if (
      quote !== '"' &&
      quote !== "'" &&
      quote !== "\\" &&
      !isAllCapsVal &&
      /^(?:(?:x-)?(?:token|authorization|auth|bearer|basic(?:[_-]?auth)?|digest|apikey|api[_-]?key|api[ \t]+key|access[_-]?token|access[_-]?key(?:[_-]?id)?|secret[_-]?key|private[_-]?key|pass|password|passwd|pwd|passphrase|x-amz-signature|signature|credentials|jwt|secret))\s*(?:=|:|is\s+|\s+)\s*$/i.test(
        match[0],
      ) &&
      (EXEMPT_AUTH_WORDS.test(cleanVal) ||
        /^(?:bearer|basic|digest|apikey|token|key|keys|access)$/i.test(cleanVal) ||
        (isBareSecretOrPassword && /^[A-Za-z]?[a-z]+$/.test(cleanVal)))
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
  const bounded = value.length > MAX_STRING * 8 ? value.slice(0, MAX_STRING * 8) : value;
  const scrubUserinfo = (_match: string, scheme: string, userinfo: string) => {
    if (userinfo === "[REDACTED]" || userinfo === "[REDACTED]:[REDACTED]") {
      return `${scheme}${userinfo}@`;
    }
    return userinfo.includes(":") ? `${scheme}[REDACTED]:[REDACTED]@` : `${scheme}[REDACTED]@`;
  };
  const withoutUserinfo = bounded.includes("@")
    ? bounded
        .replace(URL_USERINFO_DOUBLE_QUOTED, scrubUserinfo)
        .replace(URL_USERINFO_SINGLE_QUOTED, scrubUserinfo)
        .replace(URL_USERINFO_BARE, scrubUserinfo)
    : bounded;
  return scrubInlineSecrets(scrubAuthParams(scrubAuthSchemes(withoutUserinfo)));
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

const DNS_RECORD_DETAIL_KEYS = new Set([
  "missing",
  "remaining",
  "unexpected",
  "collateralMissing",
  "replaced",
  "conflicts",
]);

export function redact(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
  inDnsRecordList = false,
): unknown {
  if (typeof value === "string") {
    const bounded =
      value.length > MAX_STRING * 8 && !/^[\s]*["{[]/.test(value)
        ? value.slice(0, MAX_STRING * 8)
        : value;
    return scrubString(bounded, depth).slice(0, MAX_STRING);
  }
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
      return (value as unknown[])
        .slice(0, 50)
        .map((item) => redact(item, seen, depth + 1, inDnsRecordList));
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
  const isDnsRecordEntry =
    inDnsRecordList &&
    typeof safeRead(value, "type") === "string" &&
    typeof safeRead(value, "name") === "string" &&
    typeof safeRead(value, "value") === "string";
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
    if (isDnsRecordEntry && key === "value" && typeof child === "string") {
      // Preserve actionable DNS record values (such as TXT verification tokens) in structured details.
      setDataProperty(safe, key, child.slice(0, MAX_STRING));
      continue;
    }
    setDataProperty(
      safe,
      key,
      redact(child, seen, depth + 1, depth === 0 && DNS_RECORD_DETAIL_KEYS.has(key)),
    );
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
  safe.name = scrubString(nameText.slice(0, MAX_STRING * 8)).slice(0, MAX_STRING);
  if (typeof rawStack === "string") {
    const header = `${nameText}: ${messageText}`;
    const stack = rawStack.startsWith(header)
      ? `${safe.name}: ${message}${rawStack.slice(header.length)}`
      : rawStack;
    safe.stack = scrubString(stack.slice(0, MAX_STRING * 8));
  } else {
    safe.stack = undefined;
  }
  const code = safeRead(cause, "code");
  if (typeof code === "string")
    Reflect.set(safe, "code", scrubString(code.slice(0, MAX_STRING * 8)).slice(0, MAX_STRING));
  else if (typeof code === "number") Reflect.set(safe, "code", code);
  return Object.freeze(safe);
}

function deepFreeze(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item, seen);
  } else {
    for (const key of Object.keys(value)) {
      deepFreeze(Reflect.get(value, key), seen);
    }
  }
  Object.freeze(value);
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
    if (options.details) {
      const redactedDetails = redact(options.details);
      this.details =
        typeof redactedDetails === "object" &&
        redactedDetails !== null &&
        !Array.isArray(redactedDetails)
          ? (redactedDetails as Record<string, unknown>)
          : { value: redactedDetails };
      deepFreeze(this.details);
    } else {
      this.details = undefined;
    }
    this.cause = safeCause;
    // Lock SDK error fields against hook mutation while keeping the instance extensible
    // so callers and frameworks (e.g. Next.js `err.digest`) can still annotate thrown errors.
    for (const key of [
      "name",
      "message",
      "code",
      "provider",
      "statusCode",
      "retryable",
      "retryAfter",
      "details",
      "cause",
    ] as const) {
      const desc = Object.getOwnPropertyDescriptor(this, key);
      if (desc) {
        Object.defineProperty(this, key, { ...desc, writable: false, configurable: false });
      }
    }
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
