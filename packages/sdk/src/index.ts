// Bun 1.3's bundler drops the imports of an entry that only re-exports (`export { x } from`)
// when --splitting is on, so the built entry exports names it never defines and crashes on load.
// Re-exporting through local constants keeps the imports. CI pins Bun 1.3.14.
import { createDomainClient as domainClient } from "./core/client";
import {
  absoluteRecordName as absoluteName,
  canonicalRecordValue as canonicalValue,
  createDnsClient as dnsClient,
  formatCaaValue as formatCaa,
  normalizeRecordName as normalizeName,
  normalizeZone as normalizeZoneName,
  parseCaaValue as parseCaa,
  relativeRecordName as relativeName,
  sameRecord as isSameRecord,
} from "./core/dns";
import { DomainSdkError as SdkError } from "./core/errors";
import { normalizeHostname as normalizeHost } from "./core/hostname";
import { deduplicateRecords as deduplicate } from "./core/records";
import {
  createSubdomainClient as subdomainClient,
  DEFAULT_RESERVED_LABELS as defaultReservedLabels,
} from "./core/subdomains";

export const createDomainClient: typeof domainClient = domainClient;
export const createDnsClient: typeof dnsClient = dnsClient;
export const createSubdomainClient: typeof subdomainClient = subdomainClient;
export const DEFAULT_RESERVED_LABELS: typeof defaultReservedLabels = defaultReservedLabels;
export const DomainSdkError: typeof SdkError = SdkError;
export type DomainSdkError = SdkError;
export const normalizeHostname: typeof normalizeHost = normalizeHost;
export const deduplicateRecords: typeof deduplicate = deduplicate;
export const normalizeZone: typeof normalizeZoneName = normalizeZoneName;
export const normalizeRecordName: typeof normalizeName = normalizeName;
export const relativeRecordName: typeof relativeName = relativeName;
export const absoluteRecordName: typeof absoluteName = absoluteName;
export const canonicalRecordValue: typeof canonicalValue = canonicalValue;
export const parseCaaValue: typeof parseCaa = parseCaa;
export const formatCaaValue: typeof formatCaa = formatCaa;
export const sameRecord: typeof isSameRecord = isSameRecord;
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
  DnsOperation,
  DnsOperationEvent,
  DnsRecord,
  DnsRecordPurpose,
  DnsRecordStatus,
  DnsRecordType,
  Domain,
  DomainCertificate,
  DomainIssue,
  DomainLogger,
  DomainOperation,
  DomainOperationEvent,
  DomainPage,
  DomainStatus,
  DomainVerification,
  ListDomainsOptions,
  OperationOutcome,
  RequestOptions,
  RetryOptions,
  VerificationStatus,
  WaitUntilActiveOptions,
} from "./core/types";
