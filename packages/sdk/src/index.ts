import { createDomainClient as createClient } from "./core/client";
import { DomainSdkError as CoreDomainSdkError } from "./core/errors";
import { normalizeHostname as normalize } from "./core/hostname";
import { deduplicateRecords as deduplicate } from "./core/records";

export const createDomainClient: typeof createClient = (...arguments_) =>
  createClient(...arguments_);
export const deduplicateRecords: typeof deduplicate = (records) => deduplicate(records);
export const DomainSdkError: typeof CoreDomainSdkError = CoreDomainSdkError;
export type DomainSdkError = CoreDomainSdkError;
export const normalizeHostname: typeof normalize = (input, options) => normalize(input, options);
export type { DomainSdkErrorCode } from "./core/errors";
export type {
  DomainClient,
  DomainClientOptions,
  DomainProvider,
  DomainProviderCapabilities,
  ProviderContext,
} from "./core/provider";
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
  VerificationStatus,
  WaitUntilActiveOptions,
} from "./core/types";
