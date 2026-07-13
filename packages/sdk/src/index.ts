import { createDomainClient as createClient } from "./core/client";
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
