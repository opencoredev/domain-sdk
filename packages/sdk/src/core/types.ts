export type DomainStatus =
  | "pending"
  | "pending_dns"
  | "pending_verification"
  | "pending_certificate"
  | "active"
  | "misconfigured"
  | "failed"
  | "unknown";

export type VerificationStatus = "pending" | "verified" | "failed" | "unknown";
export type CertificateStatus = "pending" | "active" | "expiring" | "failed" | "unknown";
export type DnsRecordType = "A" | "AAAA" | "CNAME" | "TXT" | "CAA" | "ALIAS" | "ANAME";
export type DnsRecordPurpose = "routing" | "ownership" | "certificate" | "other";
export type DnsRecordStatus = "pending" | "valid" | "invalid" | "unknown";

export interface DnsRecord {
  type: DnsRecordType;
  name: string;
  value: string;
  ttl?: number;
  purpose: DnsRecordPurpose;
  required: boolean;
  status: DnsRecordStatus;
  description?: string;
}

export interface DomainVerification {
  status: VerificationStatus;
  records: DnsRecord[];
  message?: string;
}

export interface DomainCertificate {
  status: CertificateStatus;
  issuer?: string;
  issuedAt?: Date;
  expiresAt?: Date;
  message?: string;
}

export interface DomainIssue {
  code: string;
  message: string;
  record?: DnsRecord;
  retryable: boolean;
}

export interface Domain {
  id: string;
  hostname: string;
  provider: string;
  status: DomainStatus;
  records: DnsRecord[];
  verification: DomainVerification;
  certificate: DomainCertificate;
  issues: DomainIssue[];
  createdAt?: Date;
  updatedAt?: Date;
}

export interface DomainPage {
  domains: Domain[];
  nextCursor?: string;
}

export interface DomainLogger {
  debug?(message: string, context?: Record<string, unknown>): void;
  info?(message: string, context?: Record<string, unknown>): void;
  warn?(message: string, context?: Record<string, unknown>): void;
  error?(message: string, context?: Record<string, unknown>): void;
}

export interface RequestOptions {
  signal?: AbortSignal;
}
export interface AddDomainOptions extends RequestOptions {}
export interface GetDomainOptions extends RequestOptions {}
export interface VerifyDomainOptions extends RequestOptions {}
export interface RemoveDomainOptions extends RequestOptions {}
export interface AddDomainObject extends AddDomainOptions {
  hostname: string;
}
export interface ListDomainsOptions extends RequestOptions {
  limit?: number;
  cursor?: string;
}
/** Automatic retries for rate limits (429) and transient outages (502, 503, 504, network). */
export interface RetryOptions {
  /** Total attempts including the first. `1` disables retries. Defaults to 3. */
  maxAttempts?: number;
  /** Backoff base before jitter. Defaults to 250ms. */
  baseDelayMs?: number;
  /** Cap on any single wait, including a provider's `Retry-After`. Defaults to 10,000ms. */
  maxDelayMs?: number;
}

export interface WaitUntilActiveOptions extends RequestOptions {
  timeoutMs?: number;
  /** First delay between polls. Defaults to 5,000ms. */
  intervalMs?: number;
  /** Multiplier applied to the delay after each poll. `1` polls at a fixed interval. Defaults to 1.5. */
  backoffFactor?: number;
  /** Cap on the delay between polls. Defaults to 30,000ms. */
  maxIntervalMs?: number;
  /** Randomize each delay between half and all of its value. Defaults to false. */
  jitter?: boolean;
  onStatus?(domain: Domain): void;
}
