import { DomainSdkError } from "./errors";

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/** Normalize a user-supplied DNS hostname to lowercase ASCII. */
export function normalizeHostname(
  input: string,
  options: { allowWildcard?: boolean } = {},
): string {
  const original = input;
  let hostname = input.trim().toLowerCase();
  const invalid = (reason: string): never => {
    throw new DomainSdkError("INVALID_HOSTNAME", `Invalid hostname: ${reason}.`, {
      details: { input: original.slice(0, 255), reason },
    });
  };
  if (!hostname) invalid("the value is empty");
  if (/\s/.test(hostname)) invalid("whitespace is not allowed");
  if (hostname.includes("://")) invalid("protocols are not allowed");
  if (/[/?#@]/.test(hostname) || hostname.includes(":"))
    invalid("paths, credentials, queries, fragments, and ports are not allowed");
  const wildcard = hostname.startsWith("*.");
  if (wildcard && !options.allowWildcard) invalid("wildcard hostnames are not supported");
  if (wildcard) hostname = hostname.slice(2);
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  if (!hostname || hostname.endsWith(".")) invalid("empty DNS labels are not allowed");
  let ascii = "";
  try {
    ascii = new URL(`http://${hostname}`).hostname;
  } catch {
    invalid("internationalized hostname normalization failed");
  }
  if (!ascii || ascii.includes("%") || ascii.includes("["))
    invalid("the value is not a DNS hostname");
  if (ascii === "localhost" || ascii.endsWith(".localhost")) invalid("localhost is not supported");
  if (IPV4.test(ascii) || /^\d+$/.test(ascii)) invalid("IP addresses are not supported");
  if (ascii.length > 253) invalid("the hostname exceeds 253 characters");
  const labels = ascii.split(".");
  if (labels.length < 2) invalid("a fully qualified hostname is required");
  for (const label of labels) {
    if (!LABEL.test(label)) invalid("a DNS label is malformed");
    if (label.startsWith("xn--")) {
      try {
        const roundTrip = new URL(`http://${label}`).hostname;
        if (roundTrip !== label) invalid("a punycode label is malformed");
      } catch {
        invalid("a punycode label is malformed");
      }
    }
  }
  return wildcard ? `*.${ascii}` : ascii;
}
