import { DomainSdkError } from "./errors";
import { normalizeHostname } from "./hostname";
import type { DomainClient } from "./provider";
import type { Domain, RequestOptions, WaitUntilActiveOptions } from "./types";

export interface SubdomainClientOptions {
  /** Domain lifecycle client for the platform that serves tenant traffic. */
  domainClient: DomainClient;
  /** Parent hostname owned by the application, for example `mydomain.com`. */
  baseDomain: string;
  /** Labels that tenants must never be allowed to claim. */
  reservedLabels?: readonly string[];
}

export interface SubdomainClient {
  readonly baseDomain: string;
  readonly wildcardHostname: string;
  readonly supportsWildcard: boolean;

  /** Normalize a direct-child label and return its full tenant hostname. */
  toHostname(label: string): string;
  /** Return the normalized direct-child label for a full tenant hostname. */
  fromHostname(hostname: string): string;

  /** Attach one tenant hostname. Use when wildcard provisioning is unavailable. */
  add(label: string, options?: RequestOptions): Promise<Domain>;
  get(label: string, options?: RequestOptions): Promise<Domain>;
  refresh(label: string, options?: RequestOptions): Promise<Domain>;
  verify(label: string, options?: RequestOptions): Promise<Domain>;
  remove(label: string, options?: RequestOptions): Promise<void>;
  waitUntilActive(label: string, options?: WaitUntilActiveOptions): Promise<Domain>;

  /** Attach `*.baseDomain` once so the application can route every tenant label. */
  provisionWildcard(options?: RequestOptions): Promise<Domain>;
  getWildcard(options?: RequestOptions): Promise<Domain>;
  refreshWildcard(options?: RequestOptions): Promise<Domain>;
  verifyWildcard(options?: RequestOptions): Promise<Domain>;
  removeWildcard(options?: RequestOptions): Promise<void>;
  waitUntilWildcardActive(options?: WaitUntilActiveOptions): Promise<Domain>;
}

function invalidLabel(input: string, baseDomain: string, reason: string): never {
  throw new DomainSdkError("INVALID_HOSTNAME", `Invalid subdomain label: ${reason}.`, {
    details: { input: input.slice(0, 255), baseDomain, reason },
  });
}

/**
 * Scope domain lifecycle operations to direct tenant subdomains of one owned
 * parent domain. Tenant ownership and uniqueness remain application concerns.
 */
export function createSubdomainClient(options: SubdomainClientOptions): SubdomainClient {
  if (!options?.domainClient)
    throw new DomainSdkError("INVALID_CONFIGURATION", "A domain client is required.");
  if (typeof options.baseDomain !== "string" || !options.baseDomain.trim())
    throw new DomainSdkError("INVALID_CONFIGURATION", "A base domain is required.");

  const domainClient = options.domainClient;
  const baseDomain = normalizeHostname(options.baseDomain);
  const suffix = `.${baseDomain}`;

  const normalizeLabel = (input: string): string => {
    const candidate = input.trim();
    if (!candidate) invalidLabel(input, baseDomain, "the value is empty");
    if (candidate.includes("."))
      invalidLabel(input, baseDomain, "only one direct-child DNS label is allowed");
    if (candidate === "*") invalidLabel(input, baseDomain, "the wildcard label is reserved");

    let hostname: string;
    try {
      hostname = normalizeHostname(`${candidate}${suffix}`);
    } catch (error) {
      if (error instanceof DomainSdkError && error.code === "INVALID_HOSTNAME")
        invalidLabel(input, baseDomain, "the DNS label is malformed");
      throw error;
    }
    const label = hostname.slice(0, -suffix.length);
    if (!label || label.includes("."))
      invalidLabel(input, baseDomain, "only one direct-child DNS label is allowed");
    return label;
  };

  const reserved = new Set((options.reservedLabels ?? []).map((label) => normalizeLabel(label)));
  const allowedLabel = (input: string): string => {
    const label = normalizeLabel(input);
    if (reserved.has(label)) invalidLabel(input, baseDomain, "the label is reserved");
    return label;
  };
  const toHostname = (label: string) => `${allowedLabel(label)}${suffix}`;
  const wildcardHostname = `*.${baseDomain}`;
  const assertWildcard = () => {
    if (!domainClient.capabilities.wildcardDomains)
      throw new DomainSdkError(
        "UNSUPPORTED_OPERATION",
        `${domainClient.provider} does not support wildcard domains through Domain SDK.`,
        { provider: domainClient.provider },
      );
  };
  const withWildcard = <T>(operation: (hostname: string) => T): T => {
    assertWildcard();
    return operation(wildcardHostname);
  };

  return {
    baseDomain,
    wildcardHostname,
    get supportsWildcard() {
      return domainClient.capabilities.wildcardDomains;
    },
    toHostname,
    fromHostname(input) {
      const hostname = normalizeHostname(input);
      if (!hostname.endsWith(suffix))
        invalidLabel(input, baseDomain, `the hostname must be a child of ${baseDomain}`);
      const label = hostname.slice(0, -suffix.length);
      return allowedLabel(label);
    },
    add(label, advanced) {
      return domainClient.add(toHostname(label), advanced);
    },
    get(label, advanced) {
      return domainClient.get(toHostname(label), advanced);
    },
    refresh(label, advanced) {
      return domainClient.refresh(toHostname(label), advanced);
    },
    verify(label, advanced) {
      return domainClient.verify(toHostname(label), advanced);
    },
    remove(label, advanced) {
      return domainClient.remove(toHostname(label), advanced);
    },
    waitUntilActive(label, polling) {
      return domainClient.waitUntilActive(toHostname(label), polling);
    },
    provisionWildcard(advanced) {
      return withWildcard((hostname) => domainClient.add(hostname, advanced));
    },
    getWildcard(advanced) {
      return withWildcard((hostname) => domainClient.get(hostname, advanced));
    },
    refreshWildcard(advanced) {
      return withWildcard((hostname) => domainClient.refresh(hostname, advanced));
    },
    verifyWildcard(advanced) {
      return withWildcard((hostname) => domainClient.verify(hostname, advanced));
    },
    removeWildcard(advanced) {
      return withWildcard((hostname) => domainClient.remove(hostname, advanced));
    },
    waitUntilWildcardActive(polling) {
      return withWildcard((hostname) => domainClient.waitUntilActive(hostname, polling));
    },
  };
}
