import { abortedError, DomainSdkError, normalizeUnknownError } from "./errors";
import { normalizeHostname } from "./hostname";
import { sleep, withRetry } from "./http";
import type { DomainClient, DomainClientOptions, ProviderContext } from "./provider";
import type {
  Domain,
  DomainLogger,
  DomainOperation,
  DomainOperationEvent,
  OperationOutcome,
  WaitUntilActiveOptions,
} from "./types";

const silentLogger: DomainLogger = {};
const stopOnFailed = (domain: Domain): boolean => domain.status === "failed";

/** The error `waitUntilActive()` throws when `shouldStop` ends polling before activation. */
function stoppedError(domain: Domain, provider: string): DomainSdkError {
  return new DomainSdkError(
    "VERIFICATION_FAILED",
    `${domain.hostname} stopped at status ${domain.status} before becoming active.`,
    {
      provider,
      details: {
        hostname: domain.hostname,
        status: domain.status,
        issues: domain.issues.map(({ code, message, retryable }) => ({ code, message, retryable })),
      },
    },
  );
}
const defaultClock = { now: () => Date.now(), sleep };

export function assertServerEnvironment(): void {
  const isBrowser = typeof window !== "undefined" || typeof document !== "undefined";

  if (isBrowser) {
    throw new DomainSdkError(
      "INVALID_CONFIGURATION",
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
  const report = (event: DomainOperationEvent) => {
    try {
      options.onOperation?.(event);
    } catch {
      logger.warn?.("Domain onOperation hook threw.", {
        provider: provider.id,
        operation: event.operation,
      });
    }
  };
  const run = async <T>(
    name: DomainOperation,
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
    const started = clock.now();
    let attempts = 0;
    const finish = (outcome: OperationOutcome) =>
      report({
        operation: name,
        provider: provider.id,
        hostname,
        durationMs: clock.now() - started,
        attempts,
        ...outcome,
      });
    try {
      const result = await withRetry(
        () => {
          attempts += 1;
          return operation();
        },
        {
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
        },
      );
      logger.info?.("Domain operation completed.", {
        provider: provider.id,
        operation: name,
        hostname,
      });
      finish({ outcome: "success" });
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
      finish({ outcome: "failure", error: normalized });
      throw normalized;
    }
  };
  const normalize = (domain: Domain): Domain => ({
    ...domain,
    hostname: normalizeInput(domain.hostname),
  });
  const get = async (hostname: string, signal?: AbortSignal, retry = options.retry) => {
    const normalized = normalizeInput(hostname);
    return run(
      "get",
      normalized,
      async () => normalize(await provider.get({ hostname: normalized }, context(signal))),
      signal,
      retry,
    );
  };

  return {
    provider: provider.id,
    capabilities: provider.capabilities,
    async add(input, advanced) {
      const hostname = normalizeInput(typeof input === "string" ? input : input.hostname);
      const signal = (typeof input === "string" ? undefined : input.signal) ?? advanced?.signal;
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
    async list(input = {}) {
      if (!provider.list || !provider.capabilities.list) {
        throw new DomainSdkError(
          "UNSUPPORTED_OPERATION",
          `${provider.id} does not support listing domains.`,
          { provider: provider.id },
        );
      }
      const limit = input.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new DomainSdkError(
          "INVALID_CONFIGURATION",
          "List limit must be an integer between 1 and 100.",
          { provider: provider.id },
        );
      const list = provider.list.bind(provider);
      return run(
        "list",
        undefined,
        () => list({ limit, cursor: input.cursor }, context(input.signal)),
        input.signal,
      );
    },
    async verify(hostname, advanced) {
      if (!provider.verify || !provider.capabilities.explicitVerification) {
        throw new DomainSdkError(
          "UNSUPPORTED_OPERATION",
          `${provider.id} does not support explicit verification.`,
          { provider: provider.id },
        );
      }
      const verify = provider.verify.bind(provider);
      const normalized = normalizeInput(hostname);
      return run(
        "verify",
        normalized,
        async () => normalize(await verify({ hostname: normalized }, context(advanced?.signal))),
        advanced?.signal,
      );
    },
    async remove(hostname, advanced) {
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
      if (
        !(timeoutMs >= 0) ||
        !(intervalMs >= 250) ||
        !(backoffFactor >= 1 && Number.isFinite(backoffFactor)) ||
        !(maxIntervalMs >= intervalMs && Number.isFinite(maxIntervalMs))
      )
        throw new DomainSdkError(
          "INVALID_CONFIGURATION",
          "Polling timeout must be non-negative, interval must be at least 250ms, backoffFactor at least 1, and maxIntervalMs at least intervalMs.",
          { provider: provider.id },
        );
      const shouldStop = polling.shouldStop ?? stopOnFailed;
      const deadline = clock.now() + timeoutMs;
      for (let poll = 0; ; poll += 1) {
        if (polling.signal?.aborted) throw abortedError(provider.id, polling.signal.reason);
        const backoff = Math.min(maxIntervalMs, intervalMs * backoffFactor ** poll);
        const delay = polling.jitter ? backoff / 2 + (Math.random() * backoff) / 2 : backoff;
        let retryAfter = 0;
        try {
          // The polling loop already retries transient failures, so each poll is one attempt.
          const domain = await get(normalized, polling.signal, { maxAttempts: 1 });
          try {
            polling.onStatus?.(domain);
          } catch {
            logger.warn?.("Domain onStatus hook threw.", {
              provider: provider.id,
              hostname: normalized,
            });
          }
          if (domain.status === "active") return domain;
          // A non-retryable error, so the catch below rethrows it instead of polling again.
          if (shouldStop(domain)) throw stoppedError(domain, provider.id);
        } catch (error) {
          const normalizedError = normalizeUnknownError(error, provider.id);
          if (!normalizedError.retryable) throw normalizedError;
          retryAfter = normalizedError.retryAfter ?? 0;
        }
        const remaining = deadline - clock.now();
        // Shorten the last wait to fit the deadline, but never poll before the provider allows.
        if (remaining <= 0 || retryAfter > remaining) {
          throw new DomainSdkError(
            "TIMEOUT",
            `Timed out waiting for ${normalized} to become active.`,
            { provider: provider.id, retryable: true },
          );
        }
        await clock.sleep(Math.min(Math.max(delay, retryAfter), remaining), polling.signal);
      }
    },
  };
}
