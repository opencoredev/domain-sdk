import { createDomainClient as createClient } from "./core/client";
import { createDnsClient as createDns } from "./core/dns";
import { DomainSdkError as CoreDomainSdkError } from "./core/errors";
import { normalizeHostname as normalize } from "./core/hostname";
import { deduplicateRecords as deduplicate } from "./core/records";
import { createSubdomainClient as createSubdomains } from "./core/subdomains";

export const createDomainClient: typeof createClient = (...arguments_) =>
  createClient(...arguments_);
export const deduplicateRecords: typeof deduplicate = (records) => deduplicate(records);
export const DomainSdkError: typeof CoreDomainSdkError = CoreDomainSdkError;
export type DomainSdkError = CoreDomainSdkError;
export const normalizeHostname: typeof normalize = (input, options) => normalize(input, options);
export const createSubdomainClient: typeof createSubdomains = (options) =>
  createSubdomains(options);
export const createDnsClient: typeof createDns = (options) => createDns(options);
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
export type { SubdomainClient, SubdomainClientOptions } from "./core/subdomains";
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
  VerificationStatus,
  WaitUntilActiveOptions,
} from "./core/types";
