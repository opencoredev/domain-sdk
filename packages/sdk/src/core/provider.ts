import type {
  AddDomainObject,
  Domain,
  DomainLogger,
  DomainOperationEvent,
  DomainPage,
  ListDomainsOptions,
  RequestOptions,
  RetryOptions,
  WaitUntilActiveOptions,
} from "./types";

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
  /** Retry rate limits and transient outages. Pass `{ maxAttempts: 1 }` to disable. */
  retry?: RetryOptions;
  /**
   * Called once when each operation finishes, with its duration, attempt count, and outcome.
   * Errors thrown by the hook are logged with `logger.warn` and never change the result.
   */
  onOperation?(event: DomainOperationEvent): void;
  /** Internal deterministic-test hooks. */
  clock?: { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> };
}

export interface DomainClient {
  readonly provider: string;
  readonly capabilities: DomainProviderCapabilities;
  /** Attach a hostname. A signal on the object form wins over one in `options`. */
  add(input: string | AddDomainObject, options?: RequestOptions): Promise<Domain>;
  get(hostname: string, options?: RequestOptions): Promise<Domain>;
  /** Same as `get()`: the client keeps no cache, so every read is fresh. */
  refresh(hostname: string, options?: RequestOptions): Promise<Domain>;
  list(options?: ListDomainsOptions): Promise<DomainPage>;
  verify(hostname: string, options?: RequestOptions): Promise<Domain>;
  remove(hostname: string, options?: RequestOptions): Promise<void>;
  waitUntilActive(hostname: string, options?: WaitUntilActiveOptions): Promise<Domain>;
}
