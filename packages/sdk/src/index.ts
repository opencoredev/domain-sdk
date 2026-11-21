export { createDomainClient } from "./core/client";
export {
  absoluteRecordName,
  canonicalRecordValue,
  createDnsClient,
  formatCaaValue,
  normalizeRecordName,
  normalizeZone,
  parseCaaValue,
  relativeRecordName,
  sameRecord,
} from "./core/dns";
export { DomainSdkError } from "./core/errors";
export { normalizeHostname } from "./core/hostname";
export { deduplicateRecords } from "./core/records";
export { createSubdomainClient, DEFAULT_RESERVED_LABELS } from "./core/subdomains";
export type {
  ApplyDomainRecordsOptions,
  DnsClient,
  DnsClientOptions,
  DnsConflictPolicy,
  DnsProvider,
  DnsProviderCapabilities,
  DnsProviderContext,
  DnsProviderCreateInput,
  DnsProviderDeleteInput,
  DnsProviderZoneInput,
  DnsRecordInput,
  DnsZone,
  DnsZoneLock,
  EnsureRecordsOptions,
  RemoveRecordsOptions,
  ZoneRecord,
} from "./core/dns";
export type { DomainSdkErrorCode } from "./core/errors";
export type {
  DomainClient,
  DomainClientOptions,
  DomainProvider,
  DomainProviderCapabilities,
  ProviderContext,
} from "./core/provider";
export type {
  SubdomainClient,
  SubdomainClientOptions,
  SubdomainPage,
  TenantSubdomain,
} from "./core/subdomains";
export type {
  AddDomainObject,
  CertificateStatus,
  DnsRecord,
  DnsRecordPurpose,
  DnsRecordStatus,
  DnsRecordType,
  Domain,
  DomainCertificate,
  DomainIssue,
  DomainLogger,
  DomainPage,
  DomainStatus,
  DomainVerification,
  ListDomainsOptions,
  RequestOptions,
  RetryOptions,
  VerificationStatus,
  WaitUntilActiveOptions,
} from "./core/types";
