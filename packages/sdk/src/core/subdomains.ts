import { DomainSdkError, normalizeUnknownError, safeInstanceOf } from "./errors";
import { normalizeHostname } from "./hostname";
import type { DomainClient } from "./provider";
import type { Domain, ListDomainsOptions, RequestOptions, WaitUntilActiveOptions } from "./types";

/**
 * Labels reserved when `reservedLabels` is not set. Underscore labels such as `_acme-challenge`
 * need no entry: they are never valid tenant labels.
 */
export const DEFAULT_RESERVED_LABELS: readonly string[] = Object.freeze([
  "www",
  "api",
  "admin",
  "mail",
]);

export interface SubdomainClientOptions {
  /** Domain lifecycle client for the platform that serves tenant traffic. */
  domainClient: DomainClient;
  /** Parent hostname owned by the application, for example `mydomain.com`. */
  baseDomain: string;
  /**
   * Labels that tenants must never be allowed to claim. Defaults to `DEFAULT_RESERVED_LABELS`
   * (`www`, `api`, `admin`, `mail`). A list replaces the defaults, so pass `[]` to reserve nothing
   * or `[...DEFAULT_RESERVED_LABELS, "billing"]` to extend them.
   */
  reservedLabels?: readonly string[];
}

export interface TenantSubdomain {
  /** Normalized direct-child label, for example `acme`. */
  label: string;
  domain: Domain;
}

export interface SubdomainPage {
  subdomains: TenantSubdomain[];
  /** Pass to the next `list()` call. Present while the provider has more domains. */
  nextCursor?: string;
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
  /**
   * List tenant subdomains: direct children of `baseDomain` that are not reserved and not the
   * wildcard. Reads one provider page per call and filters it, so a page can hold fewer than
   * `limit` subdomains, or none, while `nextCursor` is still set.
   */
  list(options?: ListDomainsOptions): Promise<SubdomainPage>;

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
      if (safeInstanceOf(error, DomainSdkError) && error.code === "INVALID_HOSTNAME")
        invalidLabel(input, baseDomain, "the DNS label is malformed");
      throw error;
    }
    const label = hostname.slice(0, -suffix.length);
    if (!label || label.includes("."))
      invalidLabel(input, baseDomain, "only one direct-child DNS label is allowed");
    return label;
  };

  const reserved = new Set(
    (options.reservedLabels ?? DEFAULT_RESERVED_LABELS).map((label) => normalizeLabel(label)),
  );
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

  const fromHostname = (input: string): string => {
    const hostname = normalizeHostname(input);
    if (!hostname.endsWith(suffix))
      invalidLabel(input, baseDomain, `the hostname must be a child of ${baseDomain}`);
    const label = hostname.slice(0, -suffix.length);
    return allowedLabel(label);
  };

  return {
    baseDomain,
    wildcardHostname,
    get supportsWildcard() {
      return domainClient.capabilities.wildcardDomains;
    },
    toHostname,
    fromHostname,
    async add(label, advanced) {
      return domainClient.add(toHostname(label), advanced);
    },
    async get(label, advanced) {
      return domainClient.get(toHostname(label), advanced);
    },
    async refresh(label, advanced) {
      return domainClient.refresh(toHostname(label), advanced);
    },
    async verify(label, advanced) {
      return domainClient.verify(toHostname(label), advanced);
    },
    async remove(label, advanced) {
      return domainClient.remove(toHostname(label), advanced);
    },
    async waitUntilActive(label, polling) {
      return domainClient.waitUntilActive(toHostname(label), polling);
    },
    async list(listOptions) {
      let domains: readonly Domain[];
      let nextCursor: string | undefined;
      try {
        const page = await domainClient.list(listOptions);
        if (!page || typeof page !== "object") {
          throw new DomainSdkError("REQUEST_FAILED", "Provider returned an invalid domain page.", {
            provider: domainClient.provider,
          });
        }
        const rawDomains = page.domains;
        const rawCursor = page.nextCursor;
        if (
          !Array.isArray(rawDomains) ||
          (rawCursor !== undefined && typeof rawCursor !== "string")
        ) {
          throw new DomainSdkError("REQUEST_FAILED", "Provider returned an invalid domain page.", {
            provider: domainClient.provider,
          });
        }
        domains = Array.from(rawDomains);
        nextCursor = rawCursor;
      } catch (error) {
        if (safeInstanceOf(error, DomainSdkError)) throw error;
        throw normalizeUnknownError(error, domainClient.provider);
      }
      const subdomains: TenantSubdomain[] = [];
      for (const domain of domains) {
        let label: string;
        try {
          if (!domain || typeof domain !== "object") {
            throw new DomainSdkError(
              "REQUEST_FAILED",
              "Provider returned an invalid domain page.",
              {
                provider: domainClient.provider,
              },
            );
          }
          const hostname = domain.hostname;
          if (typeof hostname !== "string") {
            throw new DomainSdkError(
              "REQUEST_FAILED",
              "Provider returned an invalid domain page.",
              {
                provider: domainClient.provider,
              },
            );
          }
          label = fromHostname(hostname);
        } catch (error) {
          if (safeInstanceOf(error, DomainSdkError) && error.code === "INVALID_HOSTNAME") continue;
          if (safeInstanceOf(error, DomainSdkError)) throw error;
          throw normalizeUnknownError(error, domainClient.provider);
        }
        subdomains.push({ label, domain });
      }
      return { subdomains, nextCursor };
    },
    async provisionWildcard(advanced) {
      return withWildcard((hostname) => domainClient.add(hostname, advanced));
    },
    async getWildcard(advanced) {
      return withWildcard((hostname) => domainClient.get(hostname, advanced));
    },
    async refreshWildcard(advanced) {
      return withWildcard((hostname) => domainClient.refresh(hostname, advanced));
    },
    async verifyWildcard(advanced) {
      return withWildcard((hostname) => domainClient.verify(hostname, advanced));
    },
    async removeWildcard(advanced) {
      return withWildcard((hostname) => domainClient.remove(hostname, advanced));
    },
    async waitUntilWildcardActive(polling) {
      return withWildcard((hostname) => domainClient.waitUntilActive(hostname, polling));
    },
  };
}
