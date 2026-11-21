import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli/run";
import { createDomainClient } from "../src/core/client";
import { createDnsClient, type DnsProvider, type ZoneRecord } from "../src/core/dns";
import { DomainSdkError, redact } from "../src/core/errors";
import { sleep, withRetry, type Fetch } from "../src/core/http";
import { bunny } from "../src/providers/bunny";
import { cloudflareSaaS } from "../src/providers/cloudflare";
import { namecheap } from "../src/providers/namecheap";
import { netlify } from "../src/providers/netlify";
import { porkbun } from "../src/providers/porkbun";
import { railway } from "../src/providers/railway";
import { render } from "../src/providers/render";
import { spaceship } from "../src/providers/spaceship";
import { vercel } from "../src/providers/vercel";
import { memoryDnsProvider, memoryProvider } from "../src/testing";

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

describe("hardening regressions (DNS rollback, cancellation, redaction, CLI)", () => {
  test("per-record rollback does not resurrect concurrently deleted or delete concurrently added same-owner records of another type", async () => {
    const base = memoryDnsProvider({
      zones: {
        "example.com": [
          { id: "a1", type: "A", name: "example.com", value: "1.1.1.1", editable: true },
          { id: "t1", type: "TXT", name: "example.com", value: "old-txt", editable: true },
        ],
      },
    });
    const origCreate = base.createRecords.bind(base);
    const origDelete = base.deleteRecords.bind(base);
    let failFirstCreate = true;
    const provider: DnsProvider = {
      ...base,
      async createRecords(input, ctx) {
        if (failFirstCreate) {
          failFirstCreate = false;
          // Simulate concurrent external edits at the same owner on another record type.
          const oldTxt = base.records("example.com").filter((r) => r.id === "t1");
          if (oldTxt.length) await origDelete({ zone: input.zone, records: oldTxt }, ctx);
          await origCreate(
            {
              zone: input.zone,
              records: [{ type: "TXT", name: "example.com", value: "concurrent-txt" }],
            },
            ctx,
          );
          throw new DomainSdkError("PROVIDER_UNAVAILABLE", "simulated create failure", {
            provider: base.id,
          });
        }
        return origCreate(input, ctx);
      },
    };

    const dns = createDnsClient({ provider });
    const err = await dns
      .ensureRecords([{ type: "A", name: "example.com", value: "2.2.2.2" }], {
        onConflict: "replace",
      })
      .catch((caught: unknown) => caught);

    expect(err).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: { restored: true },
    });
    const finalRecords = base.records("example.com");
    expect(finalRecords.filter((r) => r.type === "A").map((r) => r.value)).toEqual(["1.1.1.1"]);
    // Concurrent TXT deletion was NOT resurrected and concurrent TXT addition was NOT deleted.
    expect(finalRecords.filter((r) => r.type === "TXT").map((r) => r.value)).toEqual([
      "concurrent-txt",
    ]);
  });

  test("whole-zone collateral loss still triggers rollback when unrelated records disappear", async () => {
    const records: ZoneRecord[] = [
      { id: "a1", type: "A", name: "app.example.com", value: "1.1.1.1", editable: true },
      { id: "t1", type: "TXT", name: "other.example.com", value: "keep-me", editable: true },
    ];
    let dropOnFirstCreate = true;
    const wholeZoneProvider: DnsProvider = {
      id: "whole-zone-mock",
      capabilities: {
        recordTypes: ["A", "TXT"],
        ttl: { min: 60, max: 86400 },
        wholeZoneWrites: true,
        zoneInfo: false,
      },
      async listRecords() {
        return records.map((r) => ({ ...r }));
      },
      async createRecords(input) {
        if (dropOnFirstCreate) {
          dropOnFirstCreate = false;
          // Drop unrelated TXT record while creating requested A record.
          records.splice(
            records.findIndex((r) => r.name === "other.example.com"),
            1,
          );
        }
        for (const rec of input.records) {
          records.push({ id: `${rec.type}-${rec.name}-${rec.value}`, ...rec, editable: true });
        }
      },
      async deleteRecords(input) {
        for (const target of input.records) {
          const idx = records.findIndex(
            (r) => r.type === target.type && r.name === target.name && r.value === target.value,
          );
          if (idx >= 0) records.splice(idx, 1);
        }
      },
    };

    const dns = createDnsClient({ provider: wholeZoneProvider });
    const err = await dns
      .ensureRecords([{ type: "A", name: "new.example.com", value: "2.2.2.2" }])
      .catch((caught: unknown) => caught);

    expect(err).toMatchObject({
      code: "REQUEST_FAILED",
      details: { restored: true },
    });
    expect(records.map((r) => `${r.type}:${r.name}:${r.value}`)).toEqual([
      "A:app.example.com:1.1.1.1",
      "TXT:other.example.com:keep-me",
    ]);
  });

  test("preserves ABORTED on AbortError from fetch and mid-body stream reads across providers", async () => {
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    const abortingBodyFetch: Fetch = async () =>
      new Response(
        new ReadableStream({
          pull() {
            throw abortError;
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const abortingFetch: Fetch = async () => {
      throw abortError;
    };

    const pb = porkbun({ apiKey: "pk1", secretApiKey: "sk1", fetch: abortingBodyFetch });
    await expect(
      pb.listRecords({ zone: "example.com" }, { logger: noopLogger }),
    ).rejects.toMatchObject({ code: "ABORTED", provider: "porkbun" });

    const sp = spaceship({ apiKey: "k", apiSecret: "s", fetch: abortingBodyFetch });
    await expect(
      sp.listRecords({ zone: "example.com" }, { logger: noopLogger }),
    ).rejects.toMatchObject({ code: "ABORTED", provider: "spaceship" });

    const nc = namecheap({
      apiUser: "u",
      apiKey: "k",
      userName: "u",
      clientIp: "1.2.3.4",
      fetch: abortingFetch,
    });
    await expect(
      nc.listRecords({ zone: "example.com" }, { logger: noopLogger }),
    ).rejects.toMatchObject({ code: "ABORTED", provider: "namecheap" });

    const hosting = [
      vercel({ token: "t", projectId: "p", fetch: abortingFetch }),
      cloudflareSaaS({
        apiToken: "t",
        zoneId: "z",
        cnameTarget: "fallback.example.com",
        fetch: abortingFetch,
      }),
      railway({
        token: "t",
        projectId: "p",
        environmentId: "e",
        serviceId: "s",
        fetch: abortingFetch,
      }),
      render({ apiKey: "k", serviceId: "s", fetch: abortingFetch }),
      netlify({ accessToken: "t", siteId: "s", fetch: abortingFetch }),
      bunny({ apiKey: "k", pullZoneId: 123, fetch: abortingFetch }),
    ];
    for (const provider of hosting) {
      await expect(
        provider.get({ hostname: "app.example.com" }, { logger: noopLogger }),
      ).rejects.toMatchObject({
        code: "ABORTED",
        provider: provider.id,
      });
    }
  });

  test("sleep splits waits exceeding 32-bit timer cap and rejects immediately on abort", async () => {
    const controller = new AbortController();
    const pending = sleep(3_000_000_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  });

  test("redact handles x-authorization, quoted schemes, Authorization: Bearer without stray bracket, and nested JSON Bearer", () => {
    expect(redact("Authorization: Bearer super_secret_tok")).toBe("Authorization: [REDACTED]");
    expect(redact("x-authorization: CustomScheme raw_secret_123")).toBe(
      "x-authorization: [REDACTED]",
    );
    expect(redact('Authorization: CustomScheme "raw_secret_quoted"')).toBe(
      "Authorization: [REDACTED]",
    );
    const doubleEncoded = JSON.stringify(JSON.stringify({ auth: "Bearer tok_xyz_999" }));
    const redactedDouble = redact(doubleEncoded) as string;
    expect(redactedDouble).not.toContain("tok_xyz_999");
    expect(() => JSON.parse(JSON.parse(redactedDouble) as string)).not.toThrow();
  });

  test("CLI trims env vars and uses last-wins semantics for --json on parse errors", async () => {
    let stdout = "";
    let stderr = "";
    const code = await runCli(["--json", "--json=false", "--unknown-flag"], {
      env: {},
      stdout: (s) => {
        stdout += s;
      },
      stderr: (s) => {
        stderr += s;
      },
    });
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).not.toContain('"code": "USAGE"');
    expect(stderr).toContain("Run domain-sdk --help");

    let capturedAuth = "";
    let stdout2 = "";
    let stderr2 = "";
    const code2 = await runCli(["get", "app.example.com"], {
      env: {
        DOMAIN_SDK_PROVIDER: " vercel ",
        VERCEL_TOKEN: " tok_trimmed ",
        VERCEL_PROJECT_ID: " prj_trimmed ",
      },
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        capturedAuth = headers.get("authorization") ?? "";
        const url = String(input);
        if (url.includes("/config")) {
          return new Response(JSON.stringify({ misconfigured: false }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({ name: "app.example.com", apexName: "example.com", verified: true }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
      stdout: (s) => {
        stdout2 += s;
      },
      stderr: (s) => {
        stderr2 += s;
      },
    });
    expect(code2).toBe(0);
    expect(stderr2).toBe("");
    expect(stdout2).toContain("app.example.com");
    expect(capturedAuth).toBe("Bearer tok_trimmed");
  });

  test("per-record rollback preserves pre-existing non-conflicting same-owner same-type TXT/CAA records", async () => {
    const base = memoryDnsProvider({
      zones: {
        "example.com": [
          { id: "a1", type: "A", name: "example.com", value: "1.1.1.1", editable: true },
          { id: "spf", type: "TXT", name: "example.com", value: "v=spf1 ~all", editable: true },
        ],
      },
    });
    const origCreate = base.createRecords.bind(base);
    let failFirstCreate = true;
    const provider: DnsProvider = {
      ...base,
      async createRecords(input, ctx) {
        if (failFirstCreate) {
          failFirstCreate = false;
          throw new DomainSdkError("PROVIDER_UNAVAILABLE", "create rejected before writing", {
            provider: base.id,
          });
        }
        return origCreate(input, ctx);
      },
    };

    const dns = createDnsClient({ provider });
    const err = await dns
      .ensureRecords(
        [
          { type: "A", name: "example.com", value: "2.2.2.2" },
          { type: "TXT", name: "example.com", value: "vc-domain-verify=123" },
        ],
        { onConflict: "replace" },
      )
      .catch((caught: unknown) => caught);

    expect(err).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: { restored: true },
    });
    const finalRecords = base.records("example.com");
    expect(finalRecords.filter((r) => r.type === "A").map((r) => r.value)).toEqual(["1.1.1.1"]);
    // Pre-existing SPF TXT at the same (name, type) must NOT be deleted by rollback!
    expect(finalRecords.filter((r) => r.type === "TXT").map((r) => r.value)).toEqual([
      "v=spf1 ~all",
    ]);
  });

  test("redact is idempotent on Bearer/ApiKey, redacts quoted schemes/credentials, Digest, cookies, and URL userinfo", () => {
    const onceBearer = redact("Bearer secret_tok_123") as string;
    expect(onceBearer).toBe("Bearer [REDACTED]");
    expect(redact(onceBearer)).toBe("Bearer [REDACTED]");

    const onceApiKey = redact("ApiKey secret_key_456") as string;
    expect(onceApiKey).toBe("ApiKey [REDACTED]");
    expect(redact(onceApiKey)).toBe("ApiKey [REDACTED]");

    expect(redact('Bearer "fixture_secret"')).toBe("Bearer [REDACTED]");
    expect(redact('Authorization: "Bearer" fixture_secret')).toBe("Authorization: [REDACTED]");
    expect(redact('Authorization: "CustomScheme" raw_secret_xyz')).toBe(
      "Authorization: [REDACTED]",
    );
    expect(redact('Authorization: Digest username="u", response="deadbeef"')).toBe(
      "Authorization: [REDACTED]",
    );
    expect(redact("https://alice:topsecret@api.example.com/v1")).toBe(
      "https://[REDACTED]:[REDACTED]@api.example.com/v1",
    );
    expect(redact({ cookie: "sid=secret", session: "abc" })).toEqual({
      cookie: "[REDACTED]",
      session: "[REDACTED]",
    });
  });

  test("withRetry baseDelayMs: 0 never produces NaN at high attempts and Netlify rejects junk cursors", async () => {
    const seenDelays: number[] = [];
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new DomainSdkError("RATE_LIMITED", "slow down", { retryable: true });
        },
        {
          retry: { maxAttempts: 1030, baseDelayMs: 0, maxDelayMs: 1000 },
          onRetry(_err, _attempt, delayMs) {
            seenDelays.push(delayMs);
          },
        },
      ),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(attempts).toBe(1030);
    expect(seenDelays.every((d) => d === 0 && Number.isFinite(d))).toBe(true);

    const provider = netlify({
      accessToken: "t",
      siteId: "s",
      fetch: async () => new Response(JSON.stringify({ domain_aliases: [] }), { status: 200 }),
    });
    await expect(
      provider.list!({ cursor: "1junk", limit: 10 }, { logger: noopLogger }),
    ).rejects.toMatchObject({ code: "REQUEST_FAILED", provider: "netlify" });
  });

  test("redact covers JSON-escaped auth schemes, multi-cookie headers, session=, URL passwords with @, and token-only URLs", () => {
    expect(redact('Basic "dXNlcjpwYXNz"')).toBe("Basic [REDACTED]");
    expect(redact('Token "LEAK_123"')).toBe("Token [REDACTED]");
    const jsonEscaped = JSON.stringify({ message: 'Bearer "LEAK_123" and ApiKey "AK_999"' });
    const scrubbedEscaped = redact(jsonEscaped) as string;
    expect(scrubbedEscaped).not.toContain("LEAK_123");
    expect(scrubbedEscaped).not.toContain("AK_999");

    expect(redact("session=LEAK_123&ok=1")).toBe("session=[REDACTED]&ok=1");
    expect(redact("Cookie: sid=one; auth=LEAK_123")).toBe("Cookie: [REDACTED]");

    expect(redact("postgres://admin:p@ss@db.local:5432/app")).toBe(
      "postgres://[REDACTED]:[REDACTED]@db.local:5432/app",
    );
    expect(redact("redis://:pass@host:6379/0")).toBe("redis://[REDACTED]:[REDACTED]@host:6379/0");
    expect(redact("https://TOKEN@github.com/org/repo")).toBe(
      "https://[REDACTED]@github.com/org/repo",
    );
    expect(redact("https://host:8080?email=user@example.com")).toBe(
      "https://host:8080?email=user@example.com",
    );
  });

  test("CLI supports -- terminator, rejects -h as flag value, and rejects inapplicable command flags", async () => {
    let helpOut = "";
    const helpCode = await runCli(["--help", "--"], {
      env: {},
      stdout: (s) => {
        helpOut += s;
      },
      stderr: () => {},
    });
    expect(helpCode).toBe(0);
    expect(helpOut).toContain("Usage:");

    let errOut = "";
    const dashHCode = await runCli(["get", "example.com", "--provider", "-h"], {
      env: {},
      stdout: () => {},
      stderr: (s) => {
        errOut += s;
      },
    });
    expect(dashHCode).toBe(2);
    expect(errOut).toContain("--provider needs a value.");

    let badFlagOut = "";
    const badFlagCode = await runCli(
      ["get", "app.example.com", "--provider", "memory", "--limit", "bogus"],
      {
        env: {},
        providers: {
          memory: {
            required: [],
            create: () =>
              ({
                id: "memory",
                capabilities: {
                  wildcard: false,
                  apex: true,
                  dnsManagement: false,
                  list: true,
                },
                add: async () => {
                  throw new Error("unused");
                },
                get: async () => {
                  throw new Error("unused");
                },
                verify: async () => {
                  throw new Error("unused");
                },
                remove: async () => {},
                list: async () => ({ domains: [] }),
              }) as never,
          },
        },
        stdout: () => {},
        stderr: (s) => {
          badFlagOut += s;
        },
      },
    );
    expect(badFlagCode).toBe(2);
    expect(badFlagOut).toContain("--limit is not supported by get.");

    // Inapplicable command flags fail BEFORE credential checks
    let noCredFlagOut = "";
    const noCredFlagCode = await runCli(
      ["get", "example.com", "--provider", "vercel", "--limit", "bogus"],
      {
        env: {},
        stdout: () => {},
        stderr: (s) => {
          noCredFlagOut += s;
        },
      },
    );
    expect(noCredFlagCode).toBe(2);
    expect(noCredFlagOut).toContain("--limit is not supported by get.");
  });

  test("redaction handles JSON URL+email, multi-cookie punctuation/Set-Cookie, multi-token Authorization, idempotency, prose, and missing DOMException", async () => {
    const { normalizeUnknownError } = await import("../src/core/errors");

    // Compact JSON URL followed by email is preserved
    const jsonUrlEmail = '{"url":"https://example.com","email":"user@example.com"}';
    expect(redact(jsonUrlEmail)).toBe(jsonUrlEmail);

    // Cookie punctuation and multi-cookie Set-Cookie headers redact all cookies
    expect(redact("Cookie: prefs={}; sid=fixture_secret_924")).toBe("Cookie: [REDACTED]");
    expect(redact("Set-Cookie: sid=X; Path=/, refresh=zzzsecret2; Path=/")).toBe(
      "Set-Cookie: [REDACTED]",
    );

    // Multi-token Authorization redacts all tokens, and already-redacted Authorization is idempotent
    expect(redact("Authorization: Custom tok1 tok2")).toBe("Authorization: [REDACTED]");
    expect(redact("Authorization: Bearer a b c")).toBe("Authorization: [REDACTED]");
    expect(redact("Authorization: [REDACTED] failed with 401")).toBe(
      "Authorization: [REDACTED] failed with 401",
    );

    // Ordinary prose after Basic / Bearer is preserved
    expect(redact("Basic authentication is not enabled for this account")).toBe(
      "Basic authentication is not enabled for this account",
    );
    expect(redact("Bearer token required")).toBe("Bearer token required");

    // normalizeUnknownError does not throw when global DOMException is absent
    const originalDomException = globalThis.DOMException;
    try {
      Object.defineProperty(globalThis, "DOMException", {
        value: undefined,
        configurable: true,
        writable: true,
      });
      const normalized = normalizeUnknownError(new Error("boom"), "vercel");
      expect(normalized.code).toBe("UNKNOWN_ERROR");
      const abortErr = new Error("aborted");
      abortErr.name = "AbortError";
      expect(normalizeUnknownError(abortErr, "vercel").code).toBe("ABORTED");
    } finally {
      Object.defineProperty(globalThis, "DOMException", {
        value: originalDomException,
        configurable: true,
        writable: true,
      });
    }
  });

  test("whole-zone add-only rewrite rolls back cleanly and per-record rollback never resurrects externally deleted wanted records", async () => {
    // 1. Whole-zone add-only write rewritten by provider cleans up rewritten value via restore()
    const baseWhole = memoryDnsProvider();
    const wholeProvider: DnsProvider = {
      ...baseWhole,
      capabilities: { ...baseWhole.capabilities, wholeZoneWrites: true },
      createRecords: (input, ctx) =>
        baseWhole.createRecords(
          {
            ...input,
            records: input.records.map((r) => ({ ...r, value: "rewritten" })),
          },
          ctx,
        ),
    };
    const wholeDns = createDnsClient({ provider: wholeProvider });
    const wholeErr = await wholeDns
      .ensureRecords([{ type: "TXT", name: "_v.example.com", value: "expected" }])
      .catch((caught: unknown) => caught);
    expect(wholeErr).toMatchObject({
      code: "REQUEST_FAILED",
      details: { restored: true },
    });
    expect(baseWhole.records("example.com")).toEqual([]);

    // 2. Per-record rollback does not resurrect a pre-existing wanted record deleted externally
    const basePer = memoryDnsProvider({
      zones: {
        "example.com": [
          { id: "t1", type: "TXT", name: "_a.example.com", value: "already-there", editable: true },
        ],
      },
    });
    const origCreate = basePer.createRecords.bind(basePer);
    const origDelete = basePer.deleteRecords.bind(basePer);
    let failOnce = true;
    const perProvider: DnsProvider = {
      ...basePer,
      async createRecords(input, ctx) {
        if (failOnce) {
          failOnce = false;
          // External writer deletes _a while SDK is creating _b
          const existingA = basePer.records("example.com").filter((r) => r.id === "t1");
          if (existingA.length) await origDelete({ zone: input.zone, records: existingA }, ctx);
          throw new DomainSdkError("PROVIDER_UNAVAILABLE", "create failed", {
            provider: basePer.id,
          });
        }
        return origCreate(input, ctx);
      },
    };
    const perDns = createDnsClient({ provider: perProvider });
    const perErr = await perDns
      .ensureRecords([
        { type: "TXT", name: "_a.example.com", value: "already-there" },
        { type: "TXT", name: "_b.example.com", value: "new-record" },
      ])
      .catch((caught: unknown) => caught);
    expect(perErr).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: { restored: true },
    });
    // Externally deleted _a must NOT be resurrected!
    expect(basePer.records("example.com")).toEqual([]);
  });

  test("transient add-only DNS create errors still retry after clean rollback and redaction covers short Basic, alphabetic Token, escaped URLs, camelCase keys, and quoted/underscore cookies", async () => {
    // 1. Transient 503 on add-only DNS write retries and succeeds on both per-record and whole-zone hosts
    for (const wholeZoneWrites of [false, true]) {
      const base = memoryDnsProvider();
      const origCreate = base.createRecords.bind(base);
      let calls = 0;
      const provider: DnsProvider = {
        ...base,
        capabilities: { ...base.capabilities, wholeZoneWrites },
        async createRecords(input, ctx) {
          calls += 1;
          if (calls === 1) {
            throw new DomainSdkError("PROVIDER_UNAVAILABLE", "transient 503", {
              provider: base.id,
              statusCode: 503,
              retryable: true,
            });
          }
          return origCreate(input, ctx);
        },
      };
      const dns = createDnsClient({
        provider,
        retry: { maxAttempts: 3, baseDelayMs: 0 },
      });
      const created = await dns.ensureRecords([
        { type: "TXT", name: "_v.example.com", value: "ok" },
      ]);
      expect(calls).toBe(2);
      expect(created).toHaveLength(1);
    }

    // 2. Short valid Base64 Basic, alphabetic Token, JSON-escaped URL userinfo, camelCase keys, and cookie variants
    expect(redact("Basic dTpw")).toBe("Basic [REDACTED]");
    expect(redact("Token alphabeticsecret")).toBe("Token [REDACTED]");
    expect(redact("Token expired")).toBe("Token expired");
    expect(redact("https:\\/\\/admin:hunter2@db.example.com")).toBe(
      "https:\\/\\/[REDACTED]:[REDACTED]@db.example.com",
    );
    expect(redact({ sessionToken: "s1", secretAccessKey: "k1", githubToken: "g1" })).toEqual({
      sessionToken: "[REDACTED]",
      secretAccessKey: "[REDACTED]",
      githubToken: "[REDACTED]",
    });
    expect(redact("set_cookie: sid=X; Path=/, refresh=zzzsecret2; Path=/")).toBe(
      "set_cookie: [REDACTED]",
    );
    expect(redact('Cookie: "prefs={}"; sid=secret')).toBe("Cookie: [REDACTED]");
    expect(redact("https://u:p\\/w@h.com")).toBe("https://[REDACTED]:[REDACTED]@h.com");
  });

  test("whole-zone retries use fresh baselines across interleaved writes, add-only retries veto external wanted deletions, and throwing loggers do not fail committed ops", async () => {
    // 1. Whole-zone retry with interleaved removeRecords & ensureRecords preserves concurrent mutations
    const base = memoryDnsProvider({
      zones: {
        "example.com": [
          {
            id: "r0",
            type: "TXT",
            name: "_r0.example.com",
            value: "keep-initially",
            editable: true,
          },
        ],
      },
    });
    const origCreate = base.createRecords.bind(base);
    let calls = 0;
    const wholeProvider: DnsProvider = {
      ...base,
      capabilities: { ...base.capabilities, wholeZoneWrites: true },
      async createRecords(input, ctx) {
        if (++calls === 1) {
          throw new DomainSdkError("PROVIDER_UNAVAILABLE", "transient 503", {
            provider: base.id,
            statusCode: 503,
            retryable: true,
            retryAfter: 50,
          });
        }
        return origCreate(input, ctx);
      },
    };
    const wholeDns = createDnsClient({
      provider: wholeProvider,
      retry: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 50 },
    });
    const pending = wholeDns.ensureRecords([
      { type: "TXT", name: "_ra.example.com", value: "new-a" },
    ]);
    await new Promise((r) => setTimeout(r, 15));
    await wholeDns.removeRecords([
      { type: "TXT", name: "_r0.example.com", value: "keep-initially" },
    ]);
    await wholeDns.ensureRecords([{ type: "TXT", name: "_rb.example.com", value: "new-b" }]);
    const created = await pending;
    expect(created.map((r) => r.value)).toEqual(["new-a"]);
    expect(
      base
        .records("example.com")
        .map((r) => `${r.name}=${r.value}`)
        .sort(),
    ).toEqual(["_ra.example.com=new-a", "_rb.example.com=new-b"]);

    // 2. Add-only retryable 503 does NOT retry and resurrect an externally deleted pre-existing wanted record
    const basePer = memoryDnsProvider({
      zones: {
        "example.com": [
          { id: "t1", type: "TXT", name: "_a.example.com", value: "preexisting", editable: true },
        ],
      },
    });
    const origPerCreate = basePer.createRecords.bind(basePer);
    const origPerDelete = basePer.deleteRecords.bind(basePer);
    let perCalls = 0;
    const perProvider: DnsProvider = {
      ...basePer,
      async createRecords(input, ctx) {
        perCalls += 1;
        if (perCalls === 1) {
          const existingA = basePer.records("example.com").filter((r) => r.id === "t1");
          if (existingA.length) await origPerDelete({ zone: input.zone, records: existingA }, ctx);
          throw new DomainSdkError("PROVIDER_UNAVAILABLE", "transient 503", {
            provider: basePer.id,
            statusCode: 503,
            retryable: true,
          });
        }
        return origPerCreate(input, ctx);
      },
    };
    const perDns = createDnsClient({
      provider: perProvider,
      retry: { maxAttempts: 3, baseDelayMs: 0 },
    });
    await expect(
      perDns.ensureRecords([
        { type: "TXT", name: "_a.example.com", value: "preexisting" },
        { type: "TXT", name: "_b.example.com", value: "new" },
      ]),
    ).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: { restored: true, externalChange: true },
    });
    expect(perCalls).toBe(1);
    expect(basePer.records("example.com")).toEqual([]);

    // 3. Throwing logger methods never break committed DNS writes
    const throwingLogger = {
      debug() {
        throw new Error("debug boom");
      },
      info() {
        throw new Error("info boom");
      },
      warn() {
        throw new Error("warn boom");
      },
      error() {
        throw new Error("error boom");
      },
    };
    const loggedDns = createDnsClient({ provider: memoryDnsProvider(), logger: throwingLogger });
    const res = await loggedDns.ensureRecords([
      { type: "A", name: "app.example.com", value: "192.0.2.1" },
    ]);
    expect(res).toHaveLength(1);
  });

  test("whole-zone rollback preserves foreign records and external wanted deletions, flags locked replacement records, guards provider ctx.logger, handles hostile errors, double-escaped URLs, valid JSON redaction, CAA error code, Namecheap HostId churn, and strict cursors", async () => {
    const { parseCaaValue } = await import("../src/core/dns");
    const { cloudflareSaaS } = await import("../src/providers/cloudflare/index");
    const { railway } = await import("../src/providers/railway/index");
    const { namecheap } = await import("../src/providers/namecheap/index");

    // 1. Whole-zone rollback keeps foreign concurrent record, flags externalChange, and vetoes retry
    const wzBase = memoryDnsProvider({
      zones: {
        "example.com": [
          { id: "a1", type: "A", name: "example.com", value: "192.0.2.1", editable: true },
        ],
      },
    });
    const origWzCreate = wzBase.createRecords.bind(wzBase);
    let wzCalls = 0;
    const wzForeignProvider: DnsProvider = {
      ...wzBase,
      capabilities: { ...wzBase.capabilities, wholeZoneWrites: true },
      async createRecords(input, ctx) {
        wzCalls += 1;
        await origWzCreate(
          {
            zone: input.zone,
            records: [{ type: "TXT", name: "_ext.example.com", value: "foreign" }],
          },
          ctx,
        );
        throw new DomainSdkError("PROVIDER_UNAVAILABLE", "verify 503", {
          provider: wzBase.id,
          statusCode: 503,
          retryable: true,
        });
      },
    };
    const wzDns = createDnsClient({
      provider: wzForeignProvider,
      retry: { maxAttempts: 3, baseDelayMs: 0 },
    });
    await expect(
      wzDns.ensureRecords([{ type: "TXT", name: "_mine.example.com", value: "mine" }]),
    ).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: { restored: true, externalChange: true },
    });
    expect(wzCalls).toBe(1);
    expect(
      wzBase
        .records("example.com")
        .map((r) => r.name)
        .sort(),
    ).toEqual(["_ext.example.com", "example.com"]);

    // 2. Whole-zone add-only rollback does not resurrect an externally deleted pre-existing wanted record
    const wzDelBase = memoryDnsProvider({
      zones: {
        "example.com": [
          { id: "w1", type: "TXT", name: "_a.example.com", value: "pre", editable: true },
        ],
      },
    });
    const origWzDel = wzDelBase.deleteRecords.bind(wzDelBase);
    let wzDelCalls = 0;
    const wzDelProvider: DnsProvider = {
      ...wzDelBase,
      capabilities: { ...wzDelBase.capabilities, wholeZoneWrites: true },
      async createRecords(input, ctx) {
        wzDelCalls += 1;
        const pre = wzDelBase.records("example.com").filter((r) => r.id === "w1");
        if (pre.length) await origWzDel({ zone: input.zone, records: pre }, ctx);
        throw new DomainSdkError("PROVIDER_UNAVAILABLE", "transient 503", {
          provider: wzDelBase.id,
          statusCode: 503,
          retryable: true,
        });
      },
    };
    const wzDelDns = createDnsClient({
      provider: wzDelProvider,
      retry: { maxAttempts: 3, baseDelayMs: 0 },
    });
    await expect(
      wzDelDns.ensureRecords([
        { type: "TXT", name: "_a.example.com", value: "pre" },
        { type: "TXT", name: "_b.example.com", value: "new" },
      ]),
    ).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: { restored: false, externalChange: true },
    });
    expect(wzDelCalls).toBe(1);
    expect(wzDelBase.records("example.com")).toEqual([]);

    // 3. Locked replacement record left behind reports restored: false and details.unexpected
    const lockedBase = memoryDnsProvider({
      zones: {
        "example.com": [
          { id: "a1", type: "A", name: "app.example.com", value: "1.1.1.1", editable: true },
        ],
      },
    });
    let lockedAdded = false;
    let lockedCreateCalls = 0;
    const origLockedCreate = lockedBase.createRecords.bind(lockedBase);
    const lockedProvider: DnsProvider = {
      ...lockedBase,
      async listRecords(input, ctx) {
        const list = await lockedBase.listRecords(input, ctx);
        if (!lockedAdded) return list;
        return [
          ...list,
          {
            id: "locked-new",
            type: "A",
            name: "app.example.com",
            value: "2.2.2.2",
            editable: false,
          },
        ];
      },
      async createRecords(input, ctx) {
        lockedCreateCalls += 1;
        if (lockedCreateCalls === 1) {
          lockedAdded = true;
          throw new DomainSdkError("PROVIDER_UNAVAILABLE", "create failed", {
            provider: lockedBase.id,
            statusCode: 503,
            retryable: true,
          });
        }
        return origLockedCreate(input, ctx);
      },
    };
    const lockedDns = createDnsClient({ provider: lockedProvider });
    await expect(
      lockedDns.ensureRecords([{ type: "A", name: "app.example.com", value: "2.2.2.2" }], {
        onConflict: "replace",
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: {
        restored: false,
        unexpected: [{ type: "A", name: "app.example.com", value: "2.2.2.2" }],
      },
    });

    // 4. Provider ctx.logger is guarded by safeLogger in both DomainClient and DnsClient
    const boomLogger = {
      debug() {
        throw new Error("debug boom");
      },
      info() {
        throw new Error("info boom");
      },
      warn() {
        throw new Error("warn boom");
      },
      error() {
        throw new Error("error boom");
      },
    };
    const memDom = memoryProvider();
    const guardedDom = createDomainClient({
      provider: {
        ...memDom,
        async add(input, ctx) {
          const added = await memDom.add(input, ctx);
          ctx.logger.info?.("committed");
          return added;
        },
      },
      logger: boomLogger,
    });
    expect((await guardedDom.add("safe-log.example.com")).hostname).toBe("safe-log.example.com");

    // 5. Hostile Error/Proxy objects never escape as non-DomainSdkError
    const hostileCause = new Error("bad");
    Object.defineProperty(hostileCause, "code", {
      get() {
        throw new Error("code getter boom");
      },
    });
    const ownKeysProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("ownKeys boom");
        },
      },
    );
    const wrapped = new DomainSdkError("REQUEST_FAILED", "top", {
      cause: hostileCause,
      details: { evil: ownKeysProxy },
    });
    expect(wrapped.details?.evil).toBe("[Unreadable]");

    // 6. Double-escaped URL userinfo, \\/\" passwords, cause.code scrubbing, and valid JSON redaction
    expect(
      redact(JSON.stringify({ message: String.raw`https:\/\/u:LEAK_7\/w@h.com` })),
    ).not.toContain("LEAK_7");
    expect(redact('{"url":"https://u:p\\\\w@h.com"}')).not.toContain("p\\\\w");
    expect(redact('{"url":"https://u:p\\"w@h.com"}')).not.toContain('p\\"w');
    expect(JSON.parse(String(redact('{"token":"abc"}')))).toEqual({ token: "[REDACTED]" });
    const codeCause = Object.assign(new Error("boom"), { code: "Bearer secret_in_code" });
    const codeErr = new DomainSdkError("REQUEST_FAILED", "top", { cause: codeCause });
    expect((codeErr.cause as Error & { code?: string }).code).toBe("Bearer [REDACTED]");

    // 7. parseCaaValue throws INVALID_CONFIGURATION
    expect(() => parseCaaValue("garbage")).toThrow(DomainSdkError);
    try {
      parseCaaValue("garbage");
    } catch (caught) {
      expect((caught as DomainSdkError).code).toBe("INVALID_CONFIGURATION");
    }

    // 8. Cloudflare and Railway reject malformed list cursors
    const cf = createDomainClient({
      provider: cloudflareSaaS({
        apiToken: "t",
        zoneId: "z",
        cnameTarget: "c.com",
        fetch: async () => Response.json({ success: true, result: [] }),
      }),
    });
    await expect(cf.list({ cursor: "1junk" })).rejects.toMatchObject({ code: "REQUEST_FAILED" });
    await expect(cf.list({ cursor: "" })).rejects.toMatchObject({ code: "REQUEST_FAILED" });

    const rw = createDomainClient({
      provider: railway({
        token: "t",
        projectId: "p",
        environmentId: "e",
        serviceId: "s",
        fetch: async () => Response.json({ data: { domains: { customDomains: [] } } }),
      }),
    });
    await expect(rw.list({ cursor: "1junk" })).rejects.toMatchObject({ code: "REQUEST_FAILED" });
    await expect(rw.list({ cursor: "" })).rejects.toMatchObject({ code: "REQUEST_FAILED" });

    // 9. Namecheap removeRecords still removes the record after HostIds are reissued
    let hostIdVersion = 0;
    let currentHosts = [{ name: "@", type: "A", address: "192.0.2.1", ttl: "300" }];
    const ncProvider = namecheap({
      apiUser: "u",
      apiKey: "k",
      userName: "u",
      clientIp: "192.0.2.10",
      fetch: async (_input, init) => {
        const params = new URLSearchParams(String(init?.body ?? ""));
        const cmd = params.get("Command");
        if (cmd === "namecheap.domains.dns.getHosts") {
          hostIdVersion += 1;
          const items = currentHosts
            .map(
              (h, idx) =>
                `<host HostId="${hostIdVersion * 10 + idx}" Name="${h.name}" Type="${h.type}" Address="${h.address}" TTL="${h.ttl}" />`,
            )
            .join("");
          return new Response(
            `<?xml version="1.0"?><ApiResponse Status="OK"><CommandResponse><DomainDNSGetHostsResult IsUsingOurDNS="true">${items}</DomainDNSGetHostsResult></CommandResponse></ApiResponse>`,
          );
        }
        if (cmd === "namecheap.domains.dns.setHosts") {
          const next: typeof currentHosts = [];
          for (let i = 1; params.has(`HostName${i}`); i++) {
            next.push({
              name: params.get(`HostName${i}`)!,
              type: params.get(`RecordType${i}`)!,
              address: params.get(`Address${i}`)!,
              ttl: params.get(`TTL${i}`) ?? "1800",
            });
          }
          currentHosts = next;
          return new Response(
            `<?xml version="1.0"?><ApiResponse Status="OK"><CommandResponse><DomainDNSSetHostsResult IsSuccess="true" /></CommandResponse></ApiResponse>`,
          );
        }
        throw new Error(`unexpected cmd ${cmd}`);
      },
    });
    const ncDns = createDnsClient({ provider: ncProvider });
    await ncDns.removeRecords([{ type: "A", name: "example.com", value: "192.0.2.1" }]);
    expect(currentHosts).toEqual([]);
  });
});
