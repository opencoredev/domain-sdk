import { abortedError, DomainSdkError, normalizeUnknownError } from "./errors";
import { normalizeHostname } from "./hostname";
import { sleep, withRetry } from "./http";
import type { DomainClient, DomainClientOptions, ProviderContext } from "./provider";
import type { Domain, DomainLogger, WaitUntilActiveOptions } from "./types";

const silentLogger: DomainLogger = {};
const defaultClock = { now: () => Date.now(), sleep };

export function assertServerEnvironment(): void {
  const isBrowser = typeof window !== "undefined" || typeof document !== "undefined";

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
    signal?: AbortSignal,
    retry = options.retry,
  ): Promise<T> => {
    logger.debug?.("Domain operation started.", {
      provider: provider.id,
      operation: name,
      hostname,
    });
    try {
      const result = await withRetry(operation, {
        retry,
        signal,
        sleep: clock.sleep,
        onRetry: (error, attempt, delayMs) =>
          logger.warn?.("Domain operation will be retried.", {
            provider: provider.id,
            operation: name,
            hostname,
            code: error.code,
            attempt,
            delayMs,
          }),
      });
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
  const get = (hostname: string, signal?: AbortSignal, retry = options.retry) =>
    run(
      "get",
      normalizeInput(hostname),
      async () =>
        normalize(await provider.get({ hostname: normalizeInput(hostname) }, context(signal))),
      signal,
      retry,
    );

  return {
    provider: provider.id,
    capabilities: provider.capabilities,
    add(input, advanced) {
      const hostname = normalizeInput(typeof input === "string" ? input : input.hostname);
      const signal = typeof input === "string" ? advanced?.signal : input.signal;
      return run(
        "add",
        hostname,
        async () => normalize(await provider.add({ hostname }, context(signal))),
        signal,
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
      return run(
        "list",
        undefined,
        async () => provider.list!({ limit, cursor: input.cursor }, context(input.signal)),
        input.signal,
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
      return run(
        "verify",
        normalized,
        async () =>
          normalize(await provider.verify!({ hostname: normalized }, context(advanced?.signal))),
        advanced?.signal,
      );
    },
    remove(hostname, advanced) {
      const normalized = normalizeInput(hostname);
      return run(
        "remove",
        normalized,
        () => provider.remove({ hostname: normalized }, context(advanced?.signal)),
        advanced?.signal,
      );
    },
    async waitUntilActive(hostname: string, polling: WaitUntilActiveOptions = {}) {
      const normalized = normalizeInput(hostname);
      const timeoutMs = polling.timeoutMs ?? 300_000;
      const intervalMs = polling.intervalMs ?? 5_000;
      const backoffFactor = polling.backoffFactor ?? 1.5;
      const maxIntervalMs = polling.maxIntervalMs ?? Math.max(30_000, intervalMs);
      if (timeoutMs < 0 || intervalMs < 250 || backoffFactor < 1 || maxIntervalMs < intervalMs)
        throw new DomainSdkError(
          "REQUEST_FAILED",
          "Polling timeout must be non-negative, interval must be at least 250ms, backoffFactor at least 1, and maxIntervalMs at least intervalMs.",
          { provider: provider.id },
        );
      const deadline = clock.now() + timeoutMs;
      for (let poll = 0; ; poll += 1) {
        if (polling.signal?.aborted) throw abortedError(provider.id, polling.signal.reason);
        const backoff = Math.min(maxIntervalMs, intervalMs * backoffFactor ** poll);
        let retryDelay = polling.jitter ? backoff / 2 + (Math.random() * backoff) / 2 : backoff;
        try {
          // The polling loop already retries transient failures, so each poll is one attempt.
          const domain = await get(normalized, polling.signal, { maxAttempts: 1 });
          polling.onStatus?.(domain);
          if (domain.status === "active") return domain;
        } catch (error) {
          const normalizedError = normalizeUnknownError(error, provider.id);
          if (!normalizedError.retryable) throw normalizedError;
          retryDelay = Math.max(retryDelay, normalizedError.retryAfter ?? 0);
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
