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
export interface WaitUntilActiveOptions extends RequestOptions {
  timeoutMs?: number;
  intervalMs?: number;
  onStatus?(domain: Domain): void;
}
