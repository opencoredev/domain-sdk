import { abortedError, DomainSdkError } from "../core/errors";
import type { DomainProvider, ProviderContext, ProviderListInput } from "../core/provider";
import { deduplicateRecords } from "../core/records";
import type { CertificateStatus, DnsRecord, Domain, DomainPage, DomainStatus } from "../core/types";
import { createMockDnsRecord, createMockDomain } from "./factories";

export type MemoryOperation = "add" | "get" | "list" | "verify" | "remove";
export interface MemoryProviderCall {
  operation: MemoryOperation;
  hostname?: string;
  at: Date;
}
export interface MemoryProviderOptions {
  activationDelayMs?: number;
  initialStatus?: DomainStatus;
  records?: DnsRecord[] | ((hostname: string) => DnsRecord[]);
  certificateStatus?: CertificateStatus;
  latencyMs?: number;
  failures?: Partial<Record<MemoryOperation, DomainSdkError | (() => DomainSdkError)>>;
}
export interface MemoryProvider extends DomainProvider {
  readonly id: "memory";
  readonly calls: readonly MemoryProviderCall[];
  activate(hostname: string): void;
  transition(hostname: string, status: DomainStatus, certificateStatus?: CertificateStatus): void;
  reset(): void;
}

function cloneDomain(domain: Domain): Domain {
  return {
    ...domain,
    records: domain.records.map((record) => ({ ...record })),
    verification: {
      ...domain.verification,
      records: domain.verification.records.map((record) => ({ ...record })),
    },
    certificate: { ...domain.certificate },
    issues: domain.issues.map((issue) => ({
      ...issue,
      record: issue.record ? { ...issue.record } : undefined,
    })),
  };
}

export function memoryProvider(options: MemoryProviderOptions = {}): MemoryProvider {
  const domains = new Map<string, Domain>();
  const calls: MemoryProviderCall[] = [];
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const before = async (
    operation: MemoryOperation,
    context: ProviderContext,
    hostname?: string,
  ) => {
    calls.push({ operation, hostname, at: new Date() });
    if (context.signal?.aborted) throw abortedError("memory", context.signal.reason);
    if (options.latencyMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, options.latencyMs);
        context.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(abortedError("memory", context.signal?.reason));
          },
          { once: true },
        );
      });
    }
    const failure = options.failures?.[operation];
    if (failure) throw typeof failure === "function" ? failure() : failure;
  };
  const find = (hostname: string) => {
    const domain = domains.get(hostname);
    if (!domain)
      throw new DomainSdkError("DOMAIN_NOT_FOUND", `${hostname} is not configured.`, {
        provider: "memory",
      });
    return domain;
  };
  const setStatus = (
    hostname: string,
    status: DomainStatus,
    certificateStatus?: CertificateStatus,
  ) => {
    const domain = find(hostname);
    const active = status === "active";
    domain.status = status;
    domain.verification.status = active ? "verified" : domain.verification.status;
    domain.certificate.status =
      certificateStatus ?? (active ? "active" : domain.certificate.status);
    domain.records = domain.records.map((record) => ({
      ...record,
      status: active ? "valid" : record.status,
    }));
    domain.updatedAt = new Date();
  };
  const provider: MemoryProvider = {
    id: "memory",
    capabilities: {
      list: true,
      explicitVerification: true,
      managedCertificates: true,
      apexDomains: true,
      wildcardDomains: false,
    },
    get calls() {
      return calls;
    },
    async add({ hostname }, context) {
      await before("add", context, hostname);
      const existing = domains.get(hostname);
      if (existing) return cloneDomain(existing);
      const configured =
        typeof options.records === "function" ? options.records(hostname) : options.records;
      const initialStatus = options.initialStatus ?? "pending_dns";
      const initiallyActive = initialStatus === "active";
      const records = deduplicateRecords(
        (configured ?? [createMockDnsRecord({ name: hostname })]).map((record) => ({
          ...record,
          status: initiallyActive ? ("valid" as const) : record.status,
        })),
      );
      const domain = createMockDomain({
        hostname,
        id: `memory:${hostname}`,
        status: initialStatus,
        records,
        certificate: {
          status: options.certificateStatus ?? (initiallyActive ? "active" : "pending"),
        },
        verification: {
          status: initiallyActive ? "verified" : "pending",
          records: records.filter((record) => record.purpose === "ownership"),
        },
      });
      domains.set(hostname, domain);
      if (options.activationDelayMs !== undefined) {
        const timer = setTimeout(() => setStatus(hostname, "active"), options.activationDelayMs);
        timers.set(hostname, timer);
      }
      return cloneDomain(domain);
    },
    async get({ hostname }, context) {
      await before("get", context, hostname);
      return cloneDomain(find(hostname));
    },
    async list(input: ProviderListInput, context: ProviderContext): Promise<DomainPage> {
      await before("list", context);
      const offset = input.cursor ? Number.parseInt(input.cursor, 10) : 0;
      if (!Number.isFinite(offset) || offset < 0)
        throw new DomainSdkError("REQUEST_FAILED", "Invalid memory provider cursor.", {
          provider: "memory",
        });
      const all = [...domains.values()].sort((a, b) => a.hostname.localeCompare(b.hostname));
      const page = all.slice(offset, offset + input.limit).map(cloneDomain);
      const next = offset + page.length;
      return { domains: page, nextCursor: next < all.length ? String(next) : undefined };
    },
    async verify({ hostname }, context) {
      await before("verify", context, hostname);
      setStatus(hostname, "active");
      return cloneDomain(find(hostname));
    },
    async remove({ hostname }, context) {
      await before("remove", context, hostname);
      const timer = timers.get(hostname);
      if (timer) clearTimeout(timer);
      timers.delete(hostname);
      domains.delete(hostname);
    },
    activate(hostname) {
      setStatus(hostname, "active");
    },
    transition(hostname, status, certificateStatus) {
      setStatus(hostname, status, certificateStatus);
    },
    reset() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      domains.clear();
      calls.splice(0);
    },
  };
  return provider;
}

export function createFailingProvider(
  error: DomainSdkError,
  operation: MemoryOperation = "get",
): MemoryProvider {
  return memoryProvider({ failures: { [operation]: error } });
}
