import type { Domain, DomainLogger, DomainPage, ListDomainsOptions } from "./types";

export interface DomainProviderCapabilities {
  list: boolean;
  explicitVerification: boolean;
  managedCertificates: boolean;
  apexDomains: boolean;
  wildcardDomains: boolean;
}

export interface ProviderContext {
  signal?: AbortSignal;
  logger: DomainLogger;
}

export interface ProviderDomainInput {
  hostname: string;
}
export interface ProviderListInput {
  limit: number;
  cursor?: string;
}

export interface DomainProvider {
  readonly id: string;
  readonly capabilities: DomainProviderCapabilities;
  add(input: ProviderDomainInput, context: ProviderContext): Promise<Domain>;
  get(input: ProviderDomainInput, context: ProviderContext): Promise<Domain>;
  list?(input: ProviderListInput, context: ProviderContext): Promise<DomainPage>;
  verify?(input: ProviderDomainInput, context: ProviderContext): Promise<Domain>;
  remove(input: ProviderDomainInput, context: ProviderContext): Promise<void>;
}

export interface DomainClientOptions {
  provider: DomainProvider;
  logger?: DomainLogger;
  /** Internal deterministic-test hooks. */
  clock?: { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> };
}

export interface DomainClient {
  readonly provider: string;
  readonly capabilities: DomainProviderCapabilities;
  add(
    input: string | ({ hostname: string } & { signal?: AbortSignal }),
    options?: { signal?: AbortSignal },
  ): Promise<Domain>;
  get(hostname: string, options?: { signal?: AbortSignal }): Promise<Domain>;
  refresh(hostname: string, options?: { signal?: AbortSignal }): Promise<Domain>;
  list(options?: ListDomainsOptions): Promise<DomainPage>;
  verify(hostname: string, options?: { signal?: AbortSignal }): Promise<Domain>;
  remove(hostname: string, options?: { signal?: AbortSignal }): Promise<void>;
  waitUntilActive(
    hostname: string,
    options?: import("./types").WaitUntilActiveOptions,
  ): Promise<Domain>;
}
