import { abortedError, DomainSdkError, normalizeUnknownError } from "./errors";
import { normalizeHostname } from "./hostname";
import type { DomainClient, DomainClientOptions, ProviderContext } from "./provider";
import type { Domain, DomainLogger, WaitUntilActiveOptions } from "./types";

const silentLogger: DomainLogger = {};
const defaultClock = {
  now: () => Date.now(),
  sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(abortedError(undefined, signal.reason));
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortedError(undefined, signal?.reason));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
};

function assertServerEnvironment(): void {
  const isBrowser =
    typeof window !== "undefined" ||
    typeof document !== "undefined";

  if (isBrowser) {
    throw new Error(
      "Domain SDK is server-side only. Initialize it in a server route, server action, or backend service.",
    );
  }
}

/** Create a stateless custom-domain client backed by one provider adapter. */
export function createDomainClient(options: DomainClientOptions): DomainClient {
  assertServerEnvironment();
  if (!options?.provider)
    throw new DomainSdkError("INVALID_CONFIGURATION", "A domain provider is required.");
  const { provider } = options;
  const logger = options.logger ?? silentLogger;
  const clock = options.clock ?? defaultClock;
  const context = (signal?: AbortSignal): ProviderContext => ({ signal, logger });
  const normalizeInput = (hostname: string) =>
    normalizeHostname(hostname, { allowWildcard: provider.capabilities.wildcardDomains });
  const run = async <T>(
    name: string,
    hostname: string | undefined,
    operation: () => Promise<T>,
  ): Promise<T> => {
    logger.debug?.("Domain operation started.", {
      provider: provider.id,
      operation: name,
      hostname,
    });
    try {
      const result = await operation();
      logger.info?.("Domain operation completed.", {
        provider: provider.id,
        operation: name,
        hostname,
      });
      return result;
    } catch (error) {
      const normalized = normalizeUnknownError(error, provider.id);
      logger.error?.("Domain operation failed.", {
        provider: provider.id,
        operation: name,
        hostname,
        code: normalized.code,
        retryable: normalized.retryable,
      });
      throw normalized;
    }
  };
  const normalize = (domain: Domain): Domain => ({
    ...domain,
    hostname: normalizeInput(domain.hostname),
  });
  const get = (hostname: string, signal?: AbortSignal) =>
    run("get", normalizeInput(hostname), async () =>
      normalize(await provider.get({ hostname: normalizeInput(hostname) }, context(signal))),
    );

  return {
    provider: provider.id,
    capabilities: provider.capabilities,
    add(input, advanced) {
      const hostname = normalizeInput(typeof input === "string" ? input : input.hostname);
      const signal = typeof input === "string" ? advanced?.signal : input.signal;
      return run("add", hostname, async () =>
        normalize(await provider.add({ hostname }, context(signal))),
      );
    },
    get(hostname, advanced) {
      return get(hostname, advanced?.signal);
    },
    refresh(hostname, advanced) {
      return get(hostname, advanced?.signal);
    },
    list(input = {}) {
      if (!provider.list || !provider.capabilities.list) {
        throw new DomainSdkError(
          "UNSUPPORTED_OPERATION",
          `${provider.id} does not support listing domains.`,
          { provider: provider.id },
        );
      }
      const limit = input.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new DomainSdkError("REQUEST_FAILED", "List limit must be between 1 and 100.", {
          provider: provider.id,
        });
      return run("list", undefined, async () =>
        provider.list!({ limit, cursor: input.cursor }, context(input.signal)),
      );
    },
    verify(hostname, advanced) {
      if (!provider.verify || !provider.capabilities.explicitVerification) {
        throw new DomainSdkError(
          "UNSUPPORTED_OPERATION",
          `${provider.id} does not support explicit verification.`,
          { provider: provider.id },
        );
      }
      const normalized = normalizeInput(hostname);
      return run("verify", normalized, async () =>
        normalize(await provider.verify!({ hostname: normalized }, context(advanced?.signal))),
      );
    },
    remove(hostname, advanced) {
      const normalized = normalizeInput(hostname);
      return run("remove", normalized, () =>
        provider.remove({ hostname: normalized }, context(advanced?.signal)),
      );
    },
    async waitUntilActive(hostname: string, polling: WaitUntilActiveOptions = {}) {
      const normalized = normalizeInput(hostname);
      const timeoutMs = polling.timeoutMs ?? 300_000;
      const intervalMs = polling.intervalMs ?? 5_000;
      if (timeoutMs < 0 || intervalMs < 250)
        throw new DomainSdkError(
          "REQUEST_FAILED",
          "Polling timeout must be non-negative and interval must be at least 250ms.",
          { provider: provider.id },
        );
      const deadline = clock.now() + timeoutMs;
      let retryDelay = intervalMs;
      for (;;) {
        if (polling.signal?.aborted) throw abortedError(provider.id, polling.signal.reason);
        try {
          const domain = await get(normalized, polling.signal);
          polling.onStatus?.(domain);
          if (domain.status === "active") return domain;
          retryDelay = intervalMs;
        } catch (error) {
          const normalizedError = normalizeUnknownError(error, provider.id);
          if (!normalizedError.retryable) throw normalizedError;
          retryDelay = Math.max(intervalMs, normalizedError.retryAfter ?? 0);
        }
        const remaining = deadline - clock.now();
        if (remaining <= 0 || retryDelay > remaining) {
          throw new DomainSdkError(
            "TIMEOUT",
            `Timed out waiting for ${normalized} to become active.`,
            { provider: provider.id, retryable: true },
          );
        }
        await clock.sleep(retryDelay, polling.signal);
      }
    },
  };
}
