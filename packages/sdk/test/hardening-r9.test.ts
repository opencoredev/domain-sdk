import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli/run";
import { createDomainClient } from "../src/core/client";
import { createDnsClient, type DnsProvider, type ZoneRecord } from "../src/core/dns";
import { DomainSdkError, redact } from "../src/core/errors";
import { sleep, withRetry, type Fetch } from "../src/core/http";
import { createSubdomainClient } from "../src/core/subdomains";
import type { Domain } from "../src/core/types";
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

  test("whole-zone add-only rewrite keeps unrequested record with restored: false and per-record rollback never resurrects externally deleted wanted records", async () => {
    // 1. Whole-zone add-only write rewritten by provider keeps unrequested value (cannot distinguish from concurrent writer) and reports restored: false + unexpected
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
      details: {
        restored: false,
        externalChange: true,
        unexpected: [expect.objectContaining({ value: "rewritten" })],
      },
    });
    expect(baseWhole.records("example.com").map((r) => r.value)).toEqual(["rewritten"]);

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

  test("R16: whole-zone rollback preserves unrelated concurrent same-owner records, redacts chained auth schemes & __proto__, and contains hostile error.name / revoked Proxy", async () => {
    // 1. Whole-zone rollback keeps unrelated concurrent TXT sharing owner+type with baseline SPF
    const wzSameOwnerBase = memoryDnsProvider({
      zones: {
        "example.com": [
          {
            id: "spf",
            type: "TXT",
            name: "example.com",
            value: "v=spf1 -all",
            ttl: 300,
            editable: true,
          },
        ],
      },
    });
    const origSameOwnerCreate = wzSameOwnerBase.createRecords.bind(wzSameOwnerBase);
    let createCalls = 0;
    const wzProvider: DnsProvider = {
      ...wzSameOwnerBase,
      capabilities: { ...wzSameOwnerBase.capabilities, wholeZoneWrites: true },
      async createRecords(input, ctx) {
        createCalls += 1;
        await origSameOwnerCreate(input, ctx);
        if (createCalls === 1) {
          // Concurrent actor adds an unrelated TXT at apex alongside existing SPF
          await origSameOwnerCreate(
            {
              zone: input.zone,
              records: [
                {
                  type: "TXT",
                  name: "example.com",
                  value: "google-site-verification=abc",
                  ttl: 300,
                },
              ],
            },
            ctx,
          );
          throw new DomainSdkError("PROVIDER_UNAVAILABLE", "transient 503", {
            provider: wzSameOwnerBase.id,
            statusCode: 503,
            retryable: true,
          });
        }
      },
    };
    const wzDns = createDnsClient({
      provider: wzProvider,
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
    });
    const wzErr = await wzDns
      .ensureRecords([{ type: "TXT", name: "_mine.example.com", value: "mine", ttl: 300 }])
      .catch((e) => e);
    expect(wzErr).toBeInstanceOf(DomainSdkError);
    expect(wzErr).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: { restored: true, externalChange: true },
    });
    expect(createCalls).toBe(1);
    const afterRecords = await wzSameOwnerBase.listRecords({ zone: "example.com" }, { logger: {} });
    expect(afterRecords.some((r) => r.value === "google-site-verification=abc")).toBe(true);
    expect(afterRecords.some((r) => r.value === "v=spf1 -all")).toBe(true);
    expect(afterRecords.some((r) => r.value === "mine")).toBe(false);

    // 2. Chained auth scheme words ("token Bearer <secret>") redact the real secret
    const chained = new DomainSdkError("REQUEST_FAILED", "Invalid token Bearer sk_live_QQQ");
    expect(chained.message).not.toContain("sk_live_QQQ");
    expect(chained.message).toContain("Bearer [REDACTED]");

    // 3. __proto__ key in details does not mutate prototype
    const evilDetails = JSON.parse('{"__proto__":{"polluted":true},"ok":"yes"}') as Record<
      string,
      unknown
    >;
    const protoErr = new DomainSdkError("REQUEST_FAILED", "fail", { details: evilDetails });
    expect(Object.getPrototypeOf(protoErr.details)).toBe(Object.prototype);
    expect((protoErr.details as Record<string, unknown>)["polluted"]).toBeUndefined();

    // 4. Hostile Error (throwing name getter, null-proto message) and revoked Proxy normalize cleanly
    const hostileName = new Error("boom");
    Object.defineProperty(hostileName, "name", {
      get() {
        throw new Error("name-boom");
      },
    });
    const { proxy: revokedProxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const hostileMsg = new Error("ok");
    Object.defineProperty(hostileMsg, "message", {
      get() {
        return Object.create(null);
      },
    });
    expect(new DomainSdkError("UNKNOWN_ERROR", "x", { cause: hostileMsg })).toBeInstanceOf(
      DomainSdkError,
    );
    expect(new DomainSdkError("UNKNOWN_ERROR", "x", { cause: revokedProxy })).toBeInstanceOf(
      DomainSdkError,
    );

    const dcHostileName = createDomainClient({
      retry: { maxAttempts: 1 },
      provider: {
        ...memoryProvider(),
        async get() {
          throw hostileName;
        },
      },
    });
    await expect(dcHostileName.get("app.example.com")).rejects.toBeInstanceOf(DomainSdkError);

    const dcRevoked = createDomainClient({
      retry: { maxAttempts: 1 },
      provider: {
        ...memoryProvider(),
        async get() {
          throw revokedProxy;
        },
      },
    });
    await expect(dcRevoked.get("app.example.com")).rejects.toBeInstanceOf(DomainSdkError);
  });

  test("R17: whole-zone same-key concurrent ACME TXT preserved, raw URL passwords & JSON auth redaction clean, CAA quotes & getPrototypeOf Proxy contained", async () => {
    const { parseCaaValue } = await import("../src/core/dns");
    const { netlify } = await import("../src/providers/netlify/index");

    // 1. Concurrent ACME TXT at same (name, type) on whole-zone rollback is kept and blocks retry
    const acmeBase = memoryDnsProvider({ zones: { "example.com": [] } });
    const origAcmeCreate = acmeBase.createRecords.bind(acmeBase);
    let acmeCalls = 0;
    const acmeProvider: DnsProvider = {
      ...acmeBase,
      capabilities: { ...acmeBase.capabilities, wholeZoneWrites: true },
      async createRecords(input, ctx) {
        acmeCalls += 1;
        await origAcmeCreate(input, ctx);
        if (acmeCalls === 1) {
          await origAcmeCreate(
            {
              zone: input.zone,
              records: [
                {
                  type: "TXT",
                  name: "_acme-challenge.example.com",
                  value: "other-worker",
                  ttl: 60,
                },
              ],
            },
            ctx,
          );
          throw new DomainSdkError("PROVIDER_UNAVAILABLE", "transient 503", {
            provider: acmeBase.id,
            statusCode: 503,
            retryable: true,
          });
        }
      },
    };
    const acmeDns = createDnsClient({
      provider: acmeProvider,
      retry: { maxAttempts: 3, baseDelayMs: 0 },
    });
    const acmeErr = await acmeDns
      .ensureRecords([{ type: "TXT", name: "_acme-challenge.example.com", value: "mine", ttl: 60 }])
      .catch((e) => e);
    expect(acmeErr).toBeInstanceOf(DomainSdkError);
    expect(acmeErr).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: { restored: true, externalChange: true },
    });
    expect(acmeCalls).toBe(1);
    const acmeAfter = await acmeBase.listRecords({ zone: "example.com" }, { logger: {} });
    expect(acmeAfter.some((r) => r.value === "other-worker")).toBe(true);
    expect(acmeAfter.some((r) => r.value === "mine")).toBe(false);

    // 2. Raw URL passwords with \, ", ' redact cleanly; JSON with Authorization/authorization stays valid JSON
    const rawBs = new DomainSdkError(
      "REQUEST_FAILED",
      String.raw`upstream postgres://u:LEAK\w@db.example.com refused`,
    );
    expect(rawBs.message).not.toContain("LEAK");
    const rawQuote = new DomainSdkError("REQUEST_FAILED", 'https://u:LEAK"w@db.example.com');
    expect(rawQuote.message).not.toContain("LEAK");

    const jsonAuth = new DomainSdkError(
      "REQUEST_FAILED",
      JSON.stringify({ message: "Authorization: Bearer tok extra", ok: true }),
    );
    expect(() => JSON.parse(jsonAuth.message)).not.toThrow();
    expect(jsonAuth.message).not.toContain("tok");

    const jsonSpaced = new DomainSdkError(
      "REQUEST_FAILED",
      '{"authorization": "Bearer sk_live_123" , "ok": true}',
    );
    expect(() => JSON.parse(jsonSpaced.message)).not.toThrow();
    expect(jsonSpaced.message).not.toContain("sk_live_123");

    // 3. Unterminated CAA quotes rejected
    expect(() => parseCaaValue('0 issue "a')).toThrow(DomainSdkError);
    expect(() => parseCaaValue('0 issue a"')).toThrow(DomainSdkError);

    // 4. getPrototypeOf-throwing Proxy contained in readJson & withRetry
    const hostileProto = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("getPrototypeOf boom");
        },
      },
    );
    const netlifyHostile = netlify({
      accessToken: "tok",
      siteId: "site",
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull() {
              throw hostileProto;
            },
          }),
          { status: 200 },
        ),
    });
    await expect(
      netlifyHostile.get({ hostname: "app.example.com" }, { logger: {} }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  test("R18: whole-zone thrown-create preserves concurrent ACME TXT, URL redaction has no backtracking & scrubs quote-delimited passwords, benign token messages preserved, Namecheap survives bad CAA", async () => {
    const { namecheap } = await import("../src/providers/namecheap/index");

    // 1. Concurrent ACME TXT when createRecords throws before writing our record is kept and blocks retry
    const base = memoryDnsProvider({
      zones: {
        "example.com": [
          {
            id: "spf",
            type: "TXT",
            name: "example.com",
            value: "v=spf1 -all",
            ttl: 300,
            editable: true,
          },
        ],
      },
    });
    const origCreate = base.createRecords.bind(base);
    let attempts = 0;
    const thrownCreateProvider: DnsProvider = {
      ...base,
      capabilities: { ...base.capabilities, wholeZoneWrites: true },
      async createRecords(input, ctx) {
        attempts += 1;
        if (attempts === 1) {
          // Another worker writes a TXT at the same name, then our write fails before committing
          await origCreate(
            {
              zone: input.zone,
              records: [
                {
                  type: "TXT",
                  name: "_acme-challenge.example.com",
                  value: "acme-worker-2",
                  ttl: 300,
                },
              ],
            },
            ctx,
          );
          throw new DomainSdkError("PROVIDER_UNAVAILABLE", "transient 503", {
            provider: base.id,
            statusCode: 503,
            retryable: true,
          });
        }
        await origCreate(input, ctx);
      },
    };
    const thrownDns = createDnsClient({
      provider: thrownCreateProvider,
      retry: { maxAttempts: 3, baseDelayMs: 0 },
    });
    const thrownErr = await thrownDns
      .ensureRecords([
        { type: "TXT", name: "_acme-challenge.example.com", value: "acme-worker-1", ttl: 300 },
      ])
      .catch((e) => e);
    expect(thrownErr).toBeInstanceOf(DomainSdkError);
    expect(thrownErr).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: { restored: true, externalChange: true },
    });
    expect(attempts).toBe(1);
    const afterThrown = await base.listRecords({ zone: "example.com" }, { logger: {} });
    expect(afterThrown.some((r) => r.value === "acme-worker-2")).toBe(true);
    expect(afterThrown.some((r) => r.value === "acme-worker-1")).toBe(false);

    // 2. No ReDoS on repeated backslashes after URL scheme, and quote+delimiter passwords redact in JSON and raw strings
    const t0 = performance.now();
    const redosErr = new DomainSdkError(
      "REQUEST_FAILED",
      "contact @team, https://u:" + "\\".repeat(45),
    );
    expect(performance.now() - t0).toBeLessThan(200);
    expect(redosErr.code).toBe("REQUEST_FAILED");

    const jsonQuoteComma = new DomainSdkError(
      "REQUEST_FAILED",
      '{"url":"postgres://u:LEAK\\",w@db.example.com","ok":true}',
    );
    expect(jsonQuoteComma.message).not.toContain("LEAK");
    expect(() => JSON.parse(jsonQuoteComma.message)).not.toThrow();

    const rawQuoteComma = new DomainSdkError(
      "REQUEST_FAILED",
      'connect failed: postgres://u:LEAK",1@db.example.com/db',
    );
    expect(rawQuoteComma.message).not.toContain("LEAK");

    const nonJsonWithEmail = new DomainSdkError(
      "REQUEST_FAILED",
      'Error: {"url":"https://example.com","email":"user@example.com"}',
    );
    expect(nonJsonWithEmail.message).toBe(
      'Error: {"url":"https://example.com","email":"user@example.com"}',
    );

    // 3. Benign provider error messages with "token" stay readable
    expect(new DomainSdkError("AUTHENTICATION_FAILED", "Token expired.").message).toBe(
      "Token expired.",
    );
    expect(new DomainSdkError("AUTHENTICATION_FAILED", "Invalid token format.").message).toBe(
      "Invalid token format.",
    );
    expect(
      new DomainSdkError("AUTHENTICATION_FAILED", "The token provided is invalid.").message,
    ).toBe("The token provided is invalid.");

    // 4. Namecheap listRecords does not crash on a pre-existing malformed CAA record
    const ncBadCaaXml = `<?xml version="1.0"?><ApiResponse Status="OK"><CommandResponse><DomainDNSGetHostsResult IsUsingOurDNS="true"><host HostId="1" Name="@" Type="CAA" Address="garbage" TTL="300" /><host HostId="2" Name="app" Type="A" Address="1.2.3.4" TTL="300" /></DomainDNSGetHostsResult></CommandResponse></ApiResponse>`;
    const ncBadCaa = namecheap({
      apiUser: "u",
      apiKey: "k",
      clientIp: "1.2.3.4",
      fetch: async () => new Response(ncBadCaaXml, { status: 200 }),
    });
    const ncRecords = await ncBadCaa.listRecords({ zone: "example.com" }, { logger: {} });
    expect(ncRecords).toHaveLength(2);
    expect(ncRecords[0]?.value).toBe("garbage");

    // 5. Whole-zone accepted-but-dropped write + concurrent same-key ACME TXT preserves foreign record with restored: false
    let droppedZone: ZoneRecord[] = [
      { id: "a", type: "A", name: "example.com", value: "1.1.1.1", ttl: 300, editable: true },
    ];
    const droppedProvider: DnsProvider = {
      id: "whole-zone-drop",
      capabilities: {
        recordTypes: ["A", "TXT"],
        ttl: { min: 60, max: 86400 },
        wholeZoneWrites: true,
        zoneInfo: false,
      },
      async listRecords() {
        return droppedZone.map((r) => ({ ...r }));
      },
      async createRecords() {
        droppedZone = [
          ...droppedZone,
          {
            id: "acme",
            type: "TXT",
            name: "_acme-challenge.example.com",
            value: "FOREIGN-ACME",
            ttl: 300,
            editable: true,
          },
        ];
      },
      async deleteRecords({ records }) {
        const ids = new Set(records.map((r) => r.id));
        droppedZone = droppedZone.filter((r) => !ids.has(r.id));
      },
    };
    const droppedErr = await createDnsClient({
      provider: droppedProvider,
      retry: { maxAttempts: 1 },
    })
      .ensureRecords([{ type: "TXT", name: "_acme-challenge.example.com", value: "OURS" }])
      .catch((e) => e);
    expect(droppedErr).toMatchObject({
      code: "REQUEST_FAILED",
      details: {
        restored: false,
        externalChange: true,
        unexpected: [expect.objectContaining({ value: "FOREIGN-ACME" })],
      },
    });
    expect(droppedZone.some((r) => r.value === "FOREIGN-ACME")).toBe(true);

    // 6. Quoted and cross-quoted raw URL passwords redact without mangling JSON/email diagnostics
    for (const leaky of [
      'connect failed: "postgres://u:LEAK",1@db.example.com/db"',
      `connect failed: 'postgres://u:LEAK",1@db.example.com/db'`,
      `connect failed: "postgres://u:LEAK',1@db.example.com/db"`,
      JSON.stringify({ msg: `connect failed: 'postgres://u:LEAK",1@db.example.com/db'` }),
    ]) {
      const e = new DomainSdkError("REQUEST_FAILED", leaky);
      expect(e.message).not.toContain("LEAK");
      expect(e.message).toContain("[REDACTED]:[REDACTED]@");
    }
    expect(
      new DomainSdkError(
        "REQUEST_FAILED",
        `Error: {'url':'https://example.com','email':'user@example.com'}`,
      ).message,
    ).toBe(`Error: {'url':'https://example.com','email':'user@example.com'}`);

    // 7. Quoted HTTP auth-param credentials redact while WWW-Authenticate Basic realm stays intact
    expect(
      new DomainSdkError("REQUEST_FAILED", 'Authorization: Token token="SUPER_SECRET_VALUE"')
        .message,
    ).not.toContain("SUPER_SECRET_VALUE");
    expect(
      new DomainSdkError("REQUEST_FAILED", 'Token token="SUPER_SECRET_VALUE"').message,
    ).not.toContain("SUPER_SECRET_VALUE");
    expect(
      new DomainSdkError("REQUEST_FAILED", 'WWW-Authenticate: Basic realm="api"').message,
    ).toBe('WWW-Authenticate: Basic realm="api"');

    // 8. Whole-zone rollback detects dropped host-managed (editable: false) records and committed deleteRecords failures
    let lockedZone: ZoneRecord[] = [
      {
        id: "ns",
        type: "NS",
        name: "example.com",
        value: "ns1.host.test",
        ttl: 300,
        editable: false,
      },
      { id: "a", type: "A", name: "example.com", value: "1.1.1.1", ttl: 300, editable: true },
    ];
    const lockedDropErr = await createDnsClient({
      retry: { maxAttempts: 1 },
      provider: {
        id: "wz-locked",
        capabilities: {
          recordTypes: ["A", "TXT"],
          ttl: { min: 60, max: 86400 },
          wholeZoneWrites: true,
          zoneInfo: false,
        },
        async listRecords() {
          return lockedZone.map((r) => ({ ...r }));
        },
        async createRecords() {
          lockedZone = lockedZone.filter((r) => r.id !== "ns");
          throw new DomainSdkError("PROVIDER_UNAVAILABLE", "503", {
            provider: "wz-locked",
            statusCode: 503,
            retryable: true,
          });
        },
        async deleteRecords() {},
      },
    })
      .ensureRecords([{ type: "A", name: "new.example.com", value: "2.2.2.2" }])
      .catch((e) => e);
    expect(lockedDropErr).toMatchObject({ details: { restored: false } });

    let delCommitState: ZoneRecord[] = [
      { id: "1", type: "A", name: "example.com", value: "1.1.1.1", ttl: 1800, editable: true },
    ];
    const delCommitErr = await createDnsClient({
      retry: { maxAttempts: 1 },
      provider: {
        id: "wz-del-commit",
        capabilities: {
          recordTypes: ["A"],
          ttl: { min: 60, max: 60000 },
          wholeZoneWrites: true,
          zoneInfo: false,
        },
        async listRecords() {
          return delCommitState.map((r) => ({ ...r }));
        },
        async deleteRecords() {
          delCommitState = [
            {
              id: "2",
              type: "A",
              name: "example.com",
              value: "9.9.9.9",
              ttl: 1800,
              editable: true,
            },
          ];
          throw new DomainSdkError("REQUEST_FAILED", "did not retain", {
            provider: "wz-del-commit",
            details: { committed: true },
          });
        },
        async createRecords({ records }) {
          for (const r of records)
            delCommitState.push({ id: "3", editable: true, ttl: 1800, ...r });
        },
      },
    })
      .ensureRecords([{ type: "A", name: "example.com", value: "2.2.2.2" }], {
        zone: "example.com",
        onConflict: "replace",
      })
      .catch((e) => e);
    expect(delCommitErr).toMatchObject({
      details: {
        restored: false,
        unexpected: [expect.objectContaining({ value: "9.9.9.9" })],
      },
    });

    // 9. Namecheap post-setHosts readHosts failure marks committed: true so rewritten records report restored: false
    let ncHostsXml = `<host HostId="1" Name="@" Type="A" Address="1.1.1.1" TTL="1800" />`;
    let ncGetCalls = 0;
    const ncCommitFail = namecheap({
      apiUser: "u",
      apiKey: "k",
      clientIp: "1.2.3.4",
      fetch: async (input, init) => {
        const url = String(input);
        const body = typeof init?.body === "string" ? init.body : "";
        if (url.includes("setHosts") || body.includes("setHosts")) {
          ncHostsXml += `<host HostId="2" Name="_v" Type="TXT" Address="REWRITTEN_OURS" TTL="1800" />`;
          return new Response(
            `<?xml version="1.0"?><ApiResponse Status="OK"><CommandResponse><DomainDNSSetHostsResult IsSuccess="true" /></CommandResponse></ApiResponse>`,
            { status: 200 },
          );
        }
        ncGetCalls += 1;
        if (ncGetCalls === 3) return new Response("unavailable", { status: 503 });
        return new Response(
          `<?xml version="1.0"?><ApiResponse Status="OK"><CommandResponse><DomainDNSGetHostsResult IsUsingOurDNS="true">${ncHostsXml}</DomainDNSGetHostsResult></CommandResponse></ApiResponse>`,
          { status: 200 },
        );
      },
    });
    const ncCommitErr = await createDnsClient({
      provider: ncCommitFail,
      retry: { maxAttempts: 1 },
    })
      .ensureRecords([{ type: "TXT", name: "_v.example.com", value: '"OURS"' }])
      .catch((e) => e);
    expect(ncCommitErr).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: {
        committed: true,
        restored: false,
        externalChange: true,
        unexpected: [expect.objectContaining({ value: "REWRITTEN_OURS" })],
      },
    });

    // 10. subdomains.list wraps throwing hostname getter and malformed page.domains into DomainSdkError
    const baseDomClient = createDomainClient({ provider: memoryProvider() });
    const hostileSub = createSubdomainClient({
      baseDomain: "app.example.com",
      domainClient: {
        ...baseDomClient,
        async list() {
          return {
            domains: [
              {
                get hostname() {
                  throw new Error("hostile getter");
                },
              } as unknown as Domain,
            ],
          };
        },
      },
    });
    await expect(hostileSub.list()).rejects.toBeInstanceOf(DomainSdkError);

    // 11. R21: subdomains.list rejects non-array domains & normalizes throwing nextCursor getter
    const badDomainsSub = createSubdomainClient({
      baseDomain: "app.example.com",
      domainClient: {
        ...baseDomClient,
        async list() {
          return { domains: {} as unknown as Domain[] };
        },
      },
    });
    await expect(badDomainsSub.list()).rejects.toMatchObject({ code: "REQUEST_FAILED" });

    const hostileCursorSub = createSubdomainClient({
      baseDomain: "app.example.com",
      domainClient: {
        ...baseDomClient,
        async list() {
          return {
            domains: [],
            get nextCursor(): string {
              throw new Error("cursor Bearer SUPERSECRET_CURSOR");
            },
          };
        },
      },
    });
    const cursorErr = await hostileCursorSub.list().catch((e) => e);
    expect(cursorErr).toBeInstanceOf(DomainSdkError);
    expect(JSON.stringify(cursorErr)).not.toContain("SUPERSECRET_CURSOR");

    // 12. R21: Basic punctuation scrubbing, multi-param Token/ApiKey scrubbing, URL-after-auth intact, benign token: required preserved
    const scrubMsg = (msg: string) => new DomainSdkError("REQUEST_FAILED", msg).message;
    expect(scrubMsg("Invalid credentials: Basic dXNlcjpwYXNz.")).toBe(
      "Invalid credentials: Basic [REDACTED]",
    );
    expect(scrubMsg("Basic dXNlcjpwYXNz&x=1")).toBe("Basic [REDACTED]&x=1");
    expect(scrubMsg('Token realm="api", key="SECRET123"')).toBe("Token [REDACTED]");
    expect(scrubMsg('ApiKey id="pub", sig="SECRET123"')).toBe("ApiKey [REDACTED]");
    expect(scrubMsg('WWW-Authenticate: Basic realm="https://api.example.com"')).toBe(
      'WWW-Authenticate: Basic realm="https://api.example.com"',
    );
    expect(scrubMsg("token: required")).toBe("token: required");
    expect(scrubMsg('Authorization: Token token="S" for https://u:p@api.vercel.com')).not.toContain(
      "]:[REDACTED]",
    );
    // 12b. R22: OWS multi-param Token/ApiKey, UTF-8 short Basic, multi-colon Basic, and trailing URL/XML punctuation
    expect(scrubMsg('Token realm="api",key="SECRET123"')).toBe("Token [REDACTED]");
    expect(scrubMsg('Token realm="api" , key="SECRET123"')).toBe("Token [REDACTED]");
    expect(scrubMsg('Token realm="api", key = "SECRET123"')).toBe("Token [REDACTED]");
    expect(scrubMsg('ApiKey id="pub",sig="SECRET123"')).toBe("ApiKey [REDACTED]");
    expect(scrubMsg("Basic OsOp")).toBe("Basic [REDACTED]");
    expect(scrubMsg("Basic user:p:a:s:s")).toBe("Basic [REDACTED]");
    expect(scrubMsg("Basic dXNlcjpwYXNz?x=1")).toBe("Basic [REDACTED]?x=1");
    expect(scrubMsg("Basic dXNlcjpwYXNz</Error>")).toBe("Basic [REDACTED]</Error>");

    // 13. R21: whole-zone ensureRecords catches dropped locked NS record & tracks committed writes across post-write listRecords failure
    let wzLockedState: ZoneRecord[] = [
      {
        id: "ns1",
        type: "NS",
        name: "example.com",
        value: "ns1.host.test",
        ttl: 3600,
        editable: false,
      },
    ];
    const droppedLockedErr = await createDnsClient({
      provider: {
        id: "wz-drop-locked",
        capabilities: {
          wholeZoneWrites: true,
          recordTypes: ["A"],
          ttl: { min: 60, max: 86400 },
          zoneInfo: false,
        },
        async listRecords() {
          return [...wzLockedState];
        },
        async createRecords({ records }) {
          wzLockedState = records.map((r, i) => ({ id: `c${i}`, editable: true, ttl: 1800, ...r }));
        },
        async deleteRecords() {},
      },
    })
      .ensureRecords([{ type: "A", name: "example.com", value: "1.2.3.4" }], {
        zone: "example.com",
      })
      .catch((e) => e);
    expect(droppedLockedErr).toMatchObject({
      code: "REQUEST_FAILED",
      details: { restored: false },
    });

    let postWriteReads = 0;
    let wzRewriteState: ZoneRecord[] = [];
    const postReadFailErr = await createDnsClient({
      retry: { maxAttempts: 1 },
      provider: {
        id: "wz-post-read-fail",
        capabilities: {
          wholeZoneWrites: true,
          recordTypes: ["A"],
          ttl: { min: 60, max: 86400 },
          zoneInfo: false,
        },
        async listRecords() {
          postWriteReads += 1;
          if (postWriteReads === 2) {
            throw new DomainSdkError("PROVIDER_UNAVAILABLE", "post-write read failed");
          }
          return [...wzRewriteState];
        },
        async createRecords() {
          wzRewriteState = [
            {
              id: "rewritten",
              type: "A",
              name: "example.com",
              value: "9.9.9.9",
              ttl: 1800,
              editable: true,
            },
          ];
        },
        async deleteRecords() {},
      },
    })
      .ensureRecords([{ type: "A", name: "example.com", value: "1.2.3.4" }], {
        zone: "example.com",
      })
      .catch((e) => e);
    expect(postReadFailErr).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: {
        restored: false,
        unexpected: [expect.objectContaining({ value: "9.9.9.9" })],
      },
    });
  });

  test("R23: redacts padded Basic, ~/% tokens, multiline/space-separated auth params, empty-user Basic, and validates subdomain list entries", async () => {
    const scrub = (msg: string) => new DomainSdkError("REQUEST_FAILED", msg).message;

    // Padded Base64 Basic followed by prose
    expect(scrub("Basic YWRtaW46cGFzcw== for request")).toBe("Basic [REDACTED] for request");
    expect(scrub("Basic dXNlcjpwYXNz= for request")).toBe("Basic [REDACTED] for request");
    expect(scrub('Basic realm="example"')).toBe('Basic realm="example"');

    // RFC 7235 ~ and URL-encoded % tokens
    expect(scrub("Bearer ~SECRET123")).toBe("Bearer [REDACTED]");
    expect(scrub("Bearer ab~SECRET123")).toBe("Bearer [REDACTED]");
    expect(scrub("Token ~SECRET123")).toBe("Token [REDACTED]");
    expect(scrub("ApiKey ~SECRET123")).toBe("ApiKey [REDACTED]");
    expect(scrub("Basic dXNlcjpwYXNz%3D")).toBe("Basic [REDACTED]");
    expect(scrub("Token abc%2FSECRET")).toBe("Token [REDACTED]");

    // Multiline / folded auth headers & space/newline-separated auth params
    expect(scrub("Bearer\nSECRET123")).toBe("Bearer [REDACTED]");
    expect(scrub("Authorization: Bearer\r\n SECRET123")).toBe("Authorization: [REDACTED]");
    expect(scrub('Token id="pub" sig="SECRET123"')).toBe("Token [REDACTED]");
    expect(scrub('Token id="pub",\nsig="SECRET123"')).toBe("Token [REDACTED]");
    expect(scrub('Digest username="a",\r\nresponse="SECRET123"')).toBe("Digest [REDACTED]");

    // Empty-username plaintext Basic
    expect(scrub("Basic :mysecretpassword")).toBe("Basic [REDACTED]");

    // SubdomainClient.list() validates malformed domain items as REQUEST_FAILED
    const badDomainClient = createDomainClient({
      provider: {
        id: "bad-list",
        capabilities: {
          list: true,
          explicitVerification: true,
          managedCertificates: true,
          apexDomains: true,
          wildcardDomains: true,
        },
        async add() {
          throw new Error("unused");
        },
        async get() {
          throw new Error("unused");
        },
        async remove() {},
        async list() {
          return { domains: [null as unknown as never, { hostname: 123 } as unknown as never] };
        },
      },
    });
    const badSubClient = createSubdomainClient({
      baseDomain: "app.example.com",
      domainClient: badDomainClient,
    });
    const listErr = await badSubClient.list().catch((e) => e);
    expect(listErr).toBeInstanceOf(DomainSdkError);
    expect((listErr as DomainSdkError).code).toBe("REQUEST_FAILED");
  });

  test("R24: redacts quoted Digest delimiters, plaintext Basic punctuation, scheme:/=, bare-newline Token params; preserves pre-commit concurrent deletions and Namecheap collateralMissing", async () => {
    const scrub = (msg: string) => new DomainSdkError("REQUEST_FAILED", msg).message;

    // Quote-aware Digest & comma + space + newline continuation
    expect(scrub('Digest username="a;b", response="0123456789abcdef"')).toBe("Digest [REDACTED]");
    expect(scrub('Digest username="a}b", response="SECRET123"')).toBe("Digest [REDACTED]");
    expect(scrub('Digest username="a]b", response="SECRET123"')).toBe("Digest [REDACTED]");
    expect(scrub('Digest username="a", \r\nresponse="SECRET123"')).toBe("Digest [REDACTED]");

    // Plaintext Basic passwords with punctuation & leading punctuation tokens
    expect(scrub("Basic admin:p@ssw0rd")).toBe("Basic [REDACTED]");
    expect(scrub("Basic :@mysecretpassword")).toBe("Basic [REDACTED]");
    expect(scrub("Basic :my$ecretpw")).toBe("Basic [REDACTED]");
    expect(scrub("Basic user:hunter2#x")).toBe("Basic [REDACTED]");
    expect(scrub("Bearer abc$SECRET123")).toBe("Bearer [REDACTED]");
    expect(scrub("Bearer @SECRET123")).toBe("Bearer [REDACTED]");
    expect(scrub("Bearer #SECRET123")).toBe("Bearer [REDACTED]");

    // Scheme followed by : or = and bare-newline Token params
    expect(scrub("Bearer: SECRET123abc")).toBe("Bearer: [REDACTED]");
    expect(scrub("Bearer=SECRET123abc")).toBe("Bearer=[REDACTED]");
    expect(scrub('Token id="pub"\nsig="SECRET123"')).toBe("Token [REDACTED]");
    expect(scrub("Basic: instructions")).toBe("Basic: instructions");

    // Pre-commit whole-zone write failure must NOT resurrect unrelated concurrent deletion and must flag externalChange
    let preCommitZone: ZoneRecord[] = [
      { id: "old", type: "TXT", name: "_old.example.com", value: "old", ttl: 300, editable: true },
    ];
    let preCommitCreates = 0;
    const preCommitErr = await createDnsClient({
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5 },
      provider: {
        id: "wz-precommit",
        capabilities: {
          wholeZoneWrites: true,
          recordTypes: ["A", "TXT"],
          ttl: { min: 60, max: 86400 },
          zoneInfo: false,
        },
        async listRecords() {
          return [...preCommitZone];
        },
        async createRecords() {
          preCommitCreates += 1;
          // Another writer deletes _old concurrently while our write fails before committing (503)
          preCommitZone = [];
          throw new DomainSdkError("PROVIDER_UNAVAILABLE", "503 before commit", {
            provider: "wz-precommit",
            statusCode: 503,
            retryable: true,
          });
        },
        async deleteRecords() {},
      },
    })
      .ensureRecords([{ type: "A", name: "app.example.com", value: "1.2.3.4" }], {
        zone: "example.com",
      })
      .catch((e) => e);
    expect(preCommitCreates).toBe(1);
    expect(preCommitZone).toEqual([]);
    expect(preCommitErr).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: { restored: true, externalChange: true },
    });

    // Namecheap post-setHosts collateral loss populates details.collateralMissing
    let ncHosts = [{ name: "_keep", type: "TXT", address: "keep-me", ttl: "300" }];
    let ncSetCalls = 0;
    const ncXml = (hosts: typeof ncHosts) =>
      `<?xml version="1.0" encoding="utf-8"?><ApiResponse Status="OK"><CommandResponse Type="namecheap.domains.dns.getHosts"><DomainDNSGetHostsResult Domain="example.com" EmailType="NONE" IsUsingOurDNS="true">${hosts
        .map(
          (h, i) =>
            `<host HostId="${i + 1}" Name="${h.name}" Type="${h.type}" Address="${h.address}" MXPref="10" TTL="${h.ttl}" IsActive="true" />`,
        )
        .join("")}</DomainDNSGetHostsResult></CommandResponse></ApiResponse>`;
    const ncClient = createDnsClient({
      retry: { maxAttempts: 1 },
      provider: namecheap({
        apiUser: "u",
        apiKey: "k",
        userName: "u",
        clientIp: "1.2.3.4",
        fetch: async (url, init) => {
          const params = new URLSearchParams(
            init?.method === "POST" ? String(init.body ?? "") : new URL(String(url)).search,
          );
          const cmd = params.get("Command");
          if (cmd === "namecheap.domains.dns.getHosts") {
            return new Response(ncXml(ncHosts), { status: 200 });
          }
          if (cmd === "namecheap.domains.dns.setHosts") {
            ncSetCalls += 1;
            if (ncSetCalls === 1) {
              // Simulate Namecheap accepting setHosts but silently dropping _keep
              ncHosts = [{ name: "app", type: "A", address: "1.2.3.4", ttl: "1800" }];
            } else {
              // Rollback restores _keep
              ncHosts = [];
              for (let i = 1; params.has(`HostName${i}`); i += 1) {
                ncHosts.push({
                  name: params.get(`HostName${i}`)!,
                  type: params.get(`RecordType${i}`)!,
                  address: params.get(`Address${i}`)!,
                  ttl: params.get(`TTL${i}`)!,
                });
              }
            }
            return new Response(
              '<?xml version="1.0" encoding="utf-8"?><ApiResponse Status="OK"><CommandResponse Type="namecheap.domains.dns.setHosts"><DomainDNSSetHostsResult Domain="example.com" IsSuccess="true" /></CommandResponse></ApiResponse>',
              { status: 200 },
            );
          }
          throw new Error(`unexpected cmd ${cmd}`);
        },
      }),
    });
    const ncErr = await ncClient
      .ensureRecords([{ type: "A", name: "app.example.com", value: "1.2.3.4" }], {
        zone: "example.com",
      })
      .catch((e) => e);
    expect(ncErr).toMatchObject({
      code: "REQUEST_FAILED",
      details: {
        committed: true,
        restored: true,
        collateralMissing: [{ type: "TXT", name: "_keep.example.com", value: "keep-me" }],
      },
    });

    // R25: bare-newline Digest params, angle-bracket Bearer token, same-key editable bystander pre-commit deletion, and SubdomainClient.list() hostname pinning
    expect(scrub('Digest username="a"\nresponse="SECRET123"')).toBe("Digest [REDACTED]");
    expect(scrub("Bearer <SECRET123>")).toBe("Bearer [REDACTED]");
    expect(scrub("Basic dXNlcjpwYXNz</Error>")).toBe("Basic [REDACTED]</Error>");

    let spfZone: ZoneRecord[] = [
      {
        id: "spf",
        type: "TXT",
        name: "example.com",
        value: "v=spf1 ~all",
        ttl: 300,
        editable: true,
      },
    ];
    let spfCreates = 0;
    const spfErr = await createDnsClient({
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5 },
      provider: {
        id: "wz-bystander-del",
        capabilities: {
          wholeZoneWrites: true,
          recordTypes: ["TXT"],
          ttl: { min: 60, max: 86400 },
          zoneInfo: false,
        },
        async listRecords() {
          return [...spfZone];
        },
        async createRecords() {
          spfCreates += 1;
          spfZone = [];
          throw new DomainSdkError("PROVIDER_UNAVAILABLE", "503", {
            provider: "wz-bystander-del",
            statusCode: 503,
            retryable: true,
          });
        },
        async deleteRecords() {},
      },
    })
      .ensureRecords([{ type: "TXT", name: "example.com", value: "verify=123" }], {
        zone: "example.com",
      })
      .catch((e) => e);
    expect(spfCreates).toBe(1);
    expect(spfZone).toEqual([]);
    expect(spfErr).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: { restored: true, externalChange: true },
    });

    let flipReads = 0;
    const flipDomainClient = createDomainClient({
      provider: {
        id: "flip-list",
        capabilities: {
          list: true,
          explicitVerification: true,
          managedCertificates: true,
          apexDomains: true,
          wildcardDomains: true,
        },
        async add() {
          throw new Error("unused");
        },
        async get() {
          throw new Error("unused");
        },
        async remove() {},
        async list() {
          return {
            domains: [
              {
                id: "d1",
                status: "active",
                get hostname() {
                  flipReads += 1;
                  return flipReads === 1 ? "acme.app.example.com" : "evil.other.com";
                },
                provider: "flip-list",
                records: [],
                issues: [],
              } as unknown as never,
            ],
          };
        },
      },
    });
    const flipPage = await createSubdomainClient({
      baseDomain: "app.example.com",
      domainClient: flipDomainClient,
    }).list();
    expect(flipPage.subdomains).toHaveLength(1);
    expect(flipReads).toBe(1);
    expect(flipPage.subdomains[0]?.label).toBe("acme");
    expect(flipPage.subdomains[0]?.domain.hostname).toBe("acme.app.example.com");

    // R26: whole-zone pre-commit replacement external deletion, committed pre-wanted restoration, and redaction edge cases
    expect(scrub("Digest username=a; response=SECRET123")).toBe("Digest [REDACTED]");
    expect(scrub('Digest username="a"; response="SECRET123"')).toBe("Digest [REDACTED]");
    expect(scrub("Digest authentication is not supported.")).toBe(
      "Digest authentication is not supported.",
    );
    expect(scrub("Basic dTrp")).toBe("Basic [REDACTED]");
    expect(scrub("Basic 6Tpw")).toBe("Basic [REDACTED]");
    expect(scrub("Basic admin:pa;SECRET123")).toBe("Basic [REDACTED]");
    expect(scrub("Basic admin:pa)SECRET123")).toBe("Basic [REDACTED]");
    expect(scrub("Basic <dXNlcjpwYXNz>")).toBe("Basic [REDACTED]");
    expect(scrub("passwd=SECRET123 pwd: SECRET456")).toBe("passwd=[REDACTED] pwd: [REDACTED]");
    expect(
      new DomainSdkError("REQUEST_FAILED", "x", { details: { passwd: "SECRETVALUE", pwd: "S2" } })
        .details,
    ).toEqual({ passwd: "[REDACTED]", pwd: "[REDACTED]" });

    let preReplaceZone: ZoneRecord[] = [
      {
        id: "c1",
        type: "CNAME",
        name: "app.example.com",
        value: "old.example.net",
        ttl: 300,
        editable: true,
      },
    ];
    const preReplaceErr = await createDnsClient({
      retry: { maxAttempts: 1 },
      provider: {
        id: "wz-pre-replace",
        capabilities: {
          wholeZoneWrites: true,
          recordTypes: ["CNAME"],
          ttl: { min: 60, max: 86400 },
          zoneInfo: false,
        },
        async listRecords() {
          return [...preReplaceZone];
        },
        async deleteRecords() {
          // Concurrent writer deletes CNAME before our write commits
          preReplaceZone = [];
          throw new DomainSdkError("PROVIDER_UNAVAILABLE", "503 before commit", {
            provider: "wz-pre-replace",
            statusCode: 503,
            retryable: true,
          });
        },
        async createRecords({ records }) {
          for (const r of records) {
            preReplaceZone.push({ id: "restored", editable: true, ttl: 300, ...r });
          }
        },
      },
    })
      .ensureRecords([{ type: "CNAME", name: "app.example.com", value: "new.example.net" }], {
        zone: "example.com",
        onConflict: "replace",
      })
      .catch((e) => e);
    expect(preReplaceZone).toEqual([]);
    expect(preReplaceErr).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: { restored: false, externalChange: true },
    });

    // R27: Digest non-backtracking exempt check, Basic ,/\ passwords, space-separated and extended secret keys
    expect(
      scrub('Digest tokens=public, username="alice", response="0123456789abcdef0123456789abcdef"'),
    ).toBe("Digest [REDACTED]");
    expect(scrub('Digest authx=public, response="SECRET123"')).toBe("Digest [REDACTED]");
    expect(scrub("Basic admin:pa,SECRET123")).toBe("Basic [REDACTED]");
    expect(scrub("Basic admin:pa\\SECRET123")).toBe("Basic [REDACTED]");
    expect(scrub("passwd SECRET123 access_token SECRET456 api-key SECRET789")).toBe(
      "passwd [REDACTED] access_token [REDACTED] api-key [REDACTED]",
    );
    expect(scrub("password is SECRET123 token%3DSECRET456 X-Amz-Signature=SIG123")).toBe(
      "password is [REDACTED] token%3D[REDACTED] X-Amz-Signature=[REDACTED]",
    );
    expect(scrub('Digest authentication failed, response="SECRET123"')).toBe(
      "Digest authentication failed, response=[REDACTED]",
    );
    expect(scrub('Basic authentication failed, response="SECRET123"')).toBe(
      "Basic authentication failed, response=[REDACTED]",
    );
    expect(scrub("Basic%20dXNlcjpwYXNz password%3A%20SECRET17")).toBe(
      "Basic%20[REDACTED] password%3A%20[REDACTED]",
    );
    expect(
      new DomainSdkError("REQUEST_FAILED", "x", {
        details: {
          auth: "a",
          credentials: "c",
          bearer: "b",
          jwt: "j",
          signature: "s",
          pass: "p",
          basicAuth: "ba",
        },
      }).details,
    ).toEqual({
      auth: "[REDACTED]",
      credentials: "[REDACTED]",
      bearer: "[REDACTED]",
      jwt: "[REDACTED]",
      signature: "[REDACTED]",
      pass: "[REDACTED]",
      basicAuth: "[REDACTED]",
    });

    let commitWantedZone: ZoneRecord[] = [
      {
        id: "w1",
        type: "TXT",
        name: "example.com",
        value: "verify=NEW",
        ttl: 300,
        editable: true,
      },
      { id: "a1", type: "A", name: "example.com", value: "1.2.3.4", ttl: 300, editable: true },
    ];
    let commitCreateCalls = 0;
    const commitWantedErr = await createDnsClient({
      retry: { maxAttempts: 1 },
      provider: {
        id: "wz-commit-wanted",
        capabilities: {
          wholeZoneWrites: true,
          recordTypes: ["A", "TXT"],
          ttl: { min: 60, max: 86400 },
          zoneInfo: false,
        },
        async listRecords() {
          return [...commitWantedZone];
        },
        async createRecords({ records }) {
          commitCreateCalls += 1;
          if (commitCreateCalls === 1) {
            commitWantedZone = commitWantedZone.filter((r) => r.id !== "w1");
            throw new DomainSdkError("REQUEST_FAILED", "committed drop", {
              provider: "wz-commit-wanted",
              details: { committed: true },
            });
          }
          for (const r of records) {
            commitWantedZone.push({ id: `r-${commitCreateCalls}`, editable: true, ttl: 300, ...r });
          }
        },
        async deleteRecords() {},
      },
    })
      .ensureRecords(
        [
          { type: "TXT", name: "example.com", value: "verify=NEW" },
          { type: "TXT", name: "_other.example.com", value: "verify=NEW2" },
        ],
        { zone: "example.com" },
      )
      .catch((e) => e);
    expect(commitWantedZone.some((r) => r.value === "verify=NEW")).toBe(true);
    expect(commitWantedErr).toMatchObject({
      code: "REQUEST_FAILED",
      details: { restored: true, committed: true },
    });
    expect(commitWantedErr.details?.externalChange).toBeUndefined();
  });

  test("R29: Basic password closing delimiters, multi-param & %3D redaction, trailing credentials after exempt words, and aliased listRecords snapshot", async () => {
    for (const [input, leaked] of [
      ["Basic admin:pa}SECRET123", "SECRET123"],
      ["Basic admin:pa]SECRET123", "SECRET123"],
      ['Basic admin:pa"SECRET123', "SECRET123"],
      ["Basic admin:pa'SECRET123", "SECRET123"],
      ['Basic authentication failed, nonce="NONCE123", response="SECRET123"', "SECRET123"],
      ['Basic realm="example", nonce="NONCE123", response="SECRET123"', "SECRET123"],
      ['Basic authentication failed, cnonce="CNONCE123", opaque="OPAQUE123"', "OPAQUE123"],
      ["Digest authentication failed, response%3DSECRET123", "SECRET123"],
      ["Basic authentication failed, response%3DSECRET123", "SECRET123"],
      ["Bearer invalid SECRET123", "SECRET123"],
      ["Basic required dXNlcjpwYXNz", "dXNlcjpwYXNz"],
      ["Basic authentication failed dXNlcjpwYXNz", "dXNlcjpwYXNz"],
      ["Bearer%09SECRET123", "SECRET123"],
      ["secret SECRET123", "SECRET123"],
    ] as const) {
      const msg = new DomainSdkError("REQUEST_FAILED", input).message;
      expect(msg).not.toContain(leaked);
      expect(msg).not.toContain("NONCE123");
      expect(msg).not.toContain("CNONCE123");
      expect(msg).toContain("[REDACTED]");
    }

    // JSON wrapper and non-secret prose stay intact.
    expect(new DomainSdkError("REQUEST_FAILED", '{"header":"Basic admin:pass"}').message).toBe(
      '{"header":"Basic [REDACTED]"}',
    );
    expect(
      new DomainSdkError("REQUEST_FAILED", "Basic authentication is not supported.").message,
    ).toBe("Basic authentication is not supported.");
    expect(new DomainSdkError("REQUEST_FAILED", "Bearer token is invalid.").message).toBe(
      "Bearer token is invalid.",
    );
    expect(new DomainSdkError("REQUEST_FAILED", "secret is missing").message).toBe(
      "secret is missing",
    );

    // Provider returning and mutating its internal records array in place does not corrupt rollback baseline.
    const internalZone: ZoneRecord[] = [
      { id: "a1", type: "A", name: "example.com", value: "1.2.3.4", ttl: 300, editable: true },
    ];
    let createCalls = 0;
    const aliasedErr = await createDnsClient({
      retry: { maxAttempts: 1 },
      provider: {
        id: "aliased-list",
        capabilities: {
          wholeZoneWrites: true,
          recordTypes: ["A", "TXT"],
          ttl: { min: 60, max: 86400 },
          zoneInfo: false,
        },
        async listRecords() {
          return internalZone;
        },
        async createRecords({ records }) {
          createCalls += 1;
          if (createCalls === 1) {
            internalZone.length = 0;
            throw new DomainSdkError("REQUEST_FAILED", "wiped in place", {
              provider: "aliased-list",
              details: { committed: true },
            });
          }
          for (const r of records) {
            internalZone.push({ id: `restored-${createCalls}`, editable: true, ttl: 300, ...r });
          }
        },
        async deleteRecords() {},
      },
    })
      .ensureRecords([{ type: "TXT", name: "example.com", value: "v=1" }], { zone: "example.com" })
      .catch((e) => e);
    expect(internalZone.some((r) => r.type === "A" && r.value === "1.2.3.4")).toBe(true);
    expect(aliasedErr).toMatchObject({
      code: "REQUEST_FAILED",
      details: { restored: true, committed: true },
    });
  });

  test("R30: linear-time redaction, multi-scheme/quoted/multiline/%20%3D/inline auth redaction, concurrent locked additions, and partial-restore unexpected", async () => {
    // 1. Linear-time redaction on huge repeated auth strings (no O(N^2) blow-up).
    const t0 = performance.now();
    const bigDigest = new DomainSdkError("REQUEST_FAILED", "Digest authentication ".repeat(40_000));
    const bigBasic = new DomainSdkError("REQUEST_FAILED", 'Basic realm="a" '.repeat(40_000));
    const elapsedMs = performance.now() - t0;
    expect(bigDigest.message.length).toBeLessThanOrEqual(1_000);
    expect(bigBasic.message.length).toBeLessThanOrEqual(1_000);
    expect(elapsedMs).toBeLessThan(1_000);

    // 2. Multi-scheme lines, quoted/angle-bracketed trailing credentials, multiline Digest, %20%3D, and inline prose/credentials.
    for (const [input, leaks] of [
      [
        'Basic authentication failed; Bearer SECRET_BEARER_999, nonce="NONCE123"',
        ["SECRET_BEARER_999", "NONCE123"],
      ],
      [
        'Basic realm="example", Basic dXNlcjpwYXNz, opaque="OPAQUE123"',
        ["dXNlcjpwYXNz", "OPAQUE123"],
      ],
      ['Basic authentication failed dXNlcjpwYXNz, nonce="NONCE123"', ["dXNlcjpwYXNz", "NONCE123"]],
      ['Bearer invalid "SECRET123"', ["SECRET123"]],
      ['Basic required "dXNlcjpwYXNz"', ["dXNlcjpwYXNz"]],
      ["Basic authentication failed <dXNlcjpwYXNz>", ["dXNlcjpwYXNz"]],
      ['Bearer invalid nonce="NONCE123", response="SECRET123"', ["NONCE123", "SECRET123"]],
      [
        'Digest authentication failed\n  nonce="NONCE123", response="SECRET_DIGEST_999"',
        ["NONCE123", "SECRET_DIGEST_999"],
      ],
      ["Digest authentication failed response%20%3D%20SECRET123", ["SECRET123"]],
      [
        "Basic authentication failed, nonce%20%3D%20NONCE123, response%20%3D%20SECRET123",
        ["NONCE123", "SECRET123"],
      ],
      ["secret is SECRET123", ["SECRET123"]],
      ["password: invalid SECRET123", ["SECRET123"]],
      ["password SECRET123", ["SECRET123"]],
    ] as const) {
      const msg = new DomainSdkError("REQUEST_FAILED", input).message;
      for (const secret of leaks) expect(msg).not.toContain(secret);
      expect(msg).toContain("[REDACTED]");
    }

    // Embedded compact JSON and prose stay intact.
    expect(
      new DomainSdkError(
        "REQUEST_FAILED",
        'Upstream error: {"header":"Basic admin:pass","status":401}',
      ).message,
    ).toBe('Upstream error: {"header":"Basic [REDACTED]","status":401}');
    expect(new DomainSdkError("REQUEST_FAILED", "secret rotation failed").message).toBe(
      "secret rotation failed",
    );
    expect(new DomainSdkError("REQUEST_FAILED", "secret is missing").message).toBe(
      "secret is missing",
    );

    // 3. Concurrent locked addition during whole-zone pre-commit 503 sets externalChange and vetoes retry.
    const lockedZone: ZoneRecord[] = [];
    let lockedCreates = 0;
    const lockedErr = await createDnsClient({
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5 },
      provider: {
        id: "wz-locked-add",
        capabilities: {
          wholeZoneWrites: true,
          recordTypes: ["A", "TXT"],
          ttl: { min: 60, max: 86400 },
          zoneInfo: false,
        },
        async listRecords() {
          return lockedZone.map((r) => ({ ...r }));
        },
        async createRecords() {
          lockedCreates += 1;
          lockedZone.push({
            id: "mx-ext",
            type: "MX",
            name: "example.com",
            value: "mail.concurrent.net",
            ttl: 300,
            editable: false,
          });
          throw new DomainSdkError("PROVIDER_UNAVAILABLE", "503", {
            provider: "wz-locked-add",
            statusCode: 503,
            retryable: true,
          });
        },
        async deleteRecords() {},
      },
    })
      .ensureRecords([{ type: "TXT", name: "app.example.com", value: "wanted" }], {
        zone: "example.com",
      })
      .catch((e) => e);
    expect(lockedCreates).toBe(1);
    expect(lockedErr).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: { restored: true, externalChange: true },
    });

    // 4. Committed whole-zone write dropping un-restorable MX + leaving unexpected same-key A still reports details.unexpected.
    const partialZone: ZoneRecord[] = [
      {
        id: "mx1",
        type: "MX",
        name: "example.com",
        value: "mail.example.com",
        ttl: 300,
        editable: true,
      },
    ];
    const partialErr = await createDnsClient({
      retry: { maxAttempts: 1 },
      provider: {
        id: "wz-partial-unexp",
        capabilities: {
          wholeZoneWrites: true,
          recordTypes: ["A", "TXT"],
          ttl: { min: 60, max: 86400 },
          zoneInfo: false,
        },
        async listRecords() {
          return partialZone.map((r) => ({ ...r }));
        },
        async createRecords() {
          partialZone.length = 0;
          partialZone.push({
            id: "a-rewritten",
            type: "A",
            name: "app.example.com",
            value: "9.9.9.9",
            ttl: 300,
            editable: true,
          });
          throw new DomainSdkError("REQUEST_FAILED", "committed drop+rewrite", {
            provider: "wz-partial-unexp",
            details: { committed: true },
          });
        },
        async deleteRecords() {},
      },
    })
      .ensureRecords([{ type: "A", name: "app.example.com", value: "2.2.2.2" }], {
        zone: "example.com",
      })
      .catch((e) => e);
    expect(partialErr).toMatchObject({
      code: "REQUEST_FAILED",
      details: {
        committed: true,
        restored: false,
        externalChange: true,
        unexpected: [{ type: "A", name: "app.example.com", value: "9.9.9.9" }],
      },
    });
  });

  test("R31: linear-time Basic/LF-only redaction, quoted trailing creds, quote-comma/16-brace/pipe Basic creds, nested compact JSON, and partial-rollback foreignAdded", async () => {
    // 1. O(N) performance on LF-only newlines and repeated Basic colon+delimiters (no quadratic stall).
    const t0 = performance.now();
    new DomainSdkError("REQUEST_FAILED", "Basic authentication\n".repeat(160_000));
    new DomainSdkError("REQUEST_FAILED", "Basic " + "a".repeat(40_000) + ":" + ",b".repeat(40_000));
    expect(performance.now() - t0).toBeLessThan(500);

    // 2. Quoted trailing credentials (including lowercase/short), Basic quote-comma, 16+ braces, and pipe delimiter.
    for (const [input, leaked] of [
      ['Bearer invalid "supersecret"', "supersecret"],
      ['Bearer invalid "12345"', "12345"],
      ['secret is "lowercaseonly"', "lowercaseonly"],
      ['Basic admin:pa",SECRET123', "SECRET123"],
      ["Basic admin:pa',SECRET123", "SECRET123"],
      ["Basic admin:pa" + "}".repeat(16) + "SECRET123", "SECRET123"],
      ["Basic admin:" + "}".repeat(16) + "SECRET123", "SECRET123"],
      ["level=error|auth=Basic dXNlcjpwYXNz|status=401", "dXNlcjpwYXNz"],
    ] as const) {
      const msg = new DomainSdkError("REQUEST_FAILED", input).message;
      expect(msg).not.toContain(leaked);
      expect(msg).toContain("[REDACTED]");
    }

    // 3. Nested compact JSON preserves surrounding structure.
    expect(
      new DomainSdkError(
        "REQUEST_FAILED",
        'Upstream error: {"nested":{"header":"Basic admin:pass"},"status":401}',
      ).message,
    ).toBe('Upstream error: {"nested":{"header":"Basic [REDACTED]"},"status":401}');

    // 4. Whole-zone partial rollback (dropped un-restorable MX + foreign unrelated TXT added) sets externalChange: true.
    const z: ZoneRecord[] = [
      {
        id: "mx1",
        type: "MX",
        name: "example.com",
        value: "mail.example.com",
        ttl: 300,
        editable: true,
      },
    ];
    const pErr = await createDnsClient({
      retry: { maxAttempts: 1 },
      provider: {
        id: "wz-partial-foreign",
        capabilities: {
          wholeZoneWrites: true,
          recordTypes: ["A", "TXT"],
          ttl: { min: 60, max: 86400 },
          zoneInfo: false,
        },
        async listRecords() {
          return z.map((r) => ({ ...r }));
        },
        async createRecords() {
          z.length = 0;
          z.push({
            id: "t1",
            type: "TXT",
            name: "other.example.com",
            value: "ext",
            ttl: 300,
            editable: true,
          });
          throw new DomainSdkError("REQUEST_FAILED", "committed drop+foreign", {
            provider: "wz-partial-foreign",
            details: { committed: true },
          });
        },
        async deleteRecords() {},
      },
    })
      .ensureRecords([{ type: "A", name: "app.example.com", value: "2.2.2.2" }], {
        zone: "example.com",
      })
      .catch((e) => e);
    expect(pErr).toMatchObject({
      code: "REQUEST_FAILED",
      details: { committed: true, restored: false, externalChange: true },
    });
  });

  test("R32: O(N) delimiter/CR redaction on JSON-prefixed payloads, escaped quotes, Bearer params, spaced assignments, hostile details proxy, async onOperation, and throwing rollback externalChange", async () => {
    // 1. O(N) performance on JSON-prefixed delimiter runs, CR+LF runs, and huge cause stacks.
    const t0 = performance.now();
    new DomainSdkError("REQUEST_FAILED", "[Basic admin:pass" + "}".repeat(64_000) + "X");
    new DomainSdkError("REQUEST_FAILED", '{"a":"Basic u:p' + ",".repeat(64_000) + 'x"}');
    new DomainSdkError("REQUEST_FAILED", "{\r" + "token is invalid\n".repeat(40_000));
    const bigCause = new Error("fail");
    bigCause.stack = "Error: fail\n" + "[Basic u:p" + "}".repeat(30_000) + "X";
    new DomainSdkError("REQUEST_FAILED", "wrapped", { cause: bigCause });
    expect(performance.now() - t0).toBeLessThan(500);

    // 2. Escaped quote inside JSON-embedded Basic, Bearer params, spaced assignments, and normal prose.
    const escMsg = new DomainSdkError(
      "REQUEST_FAILED",
      'Upstream error: {"nested":{"header":"Basic admin:pa\\"SECRET"},"status":401}',
    ).message;
    expect(escMsg).not.toContain("SECRET");
    expect(escMsg).toContain('"status":401');

    for (const [input, leaked] of [
      ['Bearer token="SECRET123"', "SECRET123"],
      ['Bearer access_token="SECRET123"', "SECRET123"],
      ['token = "supersecret"', "supersecret"],
      ["TOKEN = abc123XYZ", "abc123XYZ"],
      ['bearer = "xsecret"', "xsecret"],
      ["token := abc123XYZ", "abc123XYZ"],
      ['passphrase = "my-secret-pass"', "my-secret-pass"],
    ] as const) {
      const msg = new DomainSdkError("REQUEST_FAILED", input).message;
      expect(msg).not.toContain(leaked);
      expect(msg).toContain("[REDACTED]");
    }
    expect(new DomainSdkError("REQUEST_FAILED", "Token bucket exhausted").message).toBe(
      "Token bucket exhausted",
    );

    // 3. Hostile Proxy as details still produces a plain object, never a string.
    const hostileDetails = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("denied");
        },
      },
    );
    const hostileErr = new DomainSdkError("REQUEST_FAILED", "oops", {
      details: hostileDetails as Record<string, unknown>,
    });
    expect(typeof hostileErr.details).toBe("object");
    expect(hostileErr.details).toEqual({ value: "[Unreadable]" });

    // 4. Async rejecting onOperation hook does not cause an unhandled rejection.
    const asyncHookClient = createDomainClient({
      provider: memoryProvider(),
      onOperation: (async () => {
        throw new Error("async hook fail");
      }) as unknown as () => void,
    });
    await expect(asyncHookClient.add("hook-async.example.com")).resolves.toMatchObject({
      hostname: "hook-async.example.com",
    });

    // 5. Throwing rollback after foreign addition still preserves externalChange: true.
    const tz: ZoneRecord[] = [
      { id: "t0", type: "TXT", name: "old.example.com", value: "v0", ttl: 300, editable: true },
      {
        id: "mx0",
        type: "MX",
        name: "example.com",
        value: "mail.example.com",
        ttl: 300,
        editable: true,
      },
    ];
    let createCalls = 0;
    const throwRestoreErr = await createDnsClient({
      retry: { maxAttempts: 1 },
      provider: {
        id: "wz-throw-restore",
        capabilities: {
          wholeZoneWrites: true,
          recordTypes: ["A", "TXT"],
          ttl: { min: 60, max: 86400 },
          zoneInfo: false,
        },
        async listRecords() {
          return tz.map((r) => ({ ...r }));
        },
        async createRecords() {
          createCalls += 1;
          if (createCalls === 1) {
            tz.length = 0;
            tz.push({
              id: "f1",
              type: "TXT",
              name: "foreign.example.com",
              value: "ext",
              ttl: 300,
              editable: true,
            });
            throw new DomainSdkError("REQUEST_FAILED", "first write failed", {
              provider: "wz-throw-restore",
              details: { committed: true },
            });
          }
          throw new DomainSdkError("REQUEST_FAILED", "restore write failed", {
            provider: "wz-throw-restore",
          });
        },
        async deleteRecords() {},
      },
    })
      .ensureRecords([{ type: "A", name: "app.example.com", value: "1.2.3.4" }], {
        zone: "example.com",
      })
      .catch((e) => e);
    expect(throwRestoreErr).toMatchObject({
      code: "REQUEST_FAILED",
      details: { committed: true, restored: false, externalChange: true },
    });
  });

  test("R33: TXT record details preservation, cross-realm hooks, frozen hook errors, spaced/passphrase redaction, per-record foreignSameKey, throwing restore locked record, and Cloudflare dot-segment IDs", async () => {
    // 1. DNS record values (e.g. TXT verification tokens) are preserved in structured error details.
    const txtErr = new DomainSdkError("REQUEST_FAILED", "missing", {
      details: {
        missing: [{ type: "TXT", name: "_verify.example.com", value: "token=abc123" }],
        unexpected: [{ type: "TXT", name: "_verify.example.com", value: "secret=xyz789" }],
        collateralMissing: [{ type: "TXT", name: "_verify.example.com", value: "password=p1" }],
        passphrase: "pp_secret_value",
      },
    });
    expect(txtErr.details).toMatchObject({
      missing: [{ type: "TXT", name: "_verify.example.com", value: "token=abc123" }],
      unexpected: [{ type: "TXT", name: "_verify.example.com", value: "secret=xyz789" }],
      collateralMissing: [{ type: "TXT", name: "_verify.example.com", value: "password=p1" }],
      passphrase: "[REDACTED]",
    });

    // 2. Spaced :, %3A, %3D, Basic =, Digest =, API key:, and auth= redaction.
    for (const [raw, leak] of [
      ['token : "supersecret123"', "supersecret123"],
      ["Bearer : sk_live_abc123", "sk_live_abc123"],
      ["ApiKey : ak_live_987654", "ak_live_987654"],
      ["Basic = admin:s3cr3t", "s3cr3t"],
      ['Digest = "dig_secret_99"', "dig_secret_99"],
      ["token %3A tok_enc_111", "tok_enc_111"],
      ["token %3D tok_enc_222", "tok_enc_222"],
      ["Invalid API key: sk_live_spacekey", "sk_live_spacekey"],
      ["auth=Zm9vOmJhcg==", "Zm9vOmJhcg=="],
      ["AUTH: raw_auth_val_1", "raw_auth_val_1"],
    ] as const) {
      const redacted = String(redact(raw));
      expect(redacted).not.toContain(leak);
      expect(redacted).toContain("[REDACTED]");
    }
    expect(String(redact("auth: failed"))).toBe("auth: failed");

    // 3. Cross-realm promise from onOperation does not leak unhandled rejection,
    //    and onOperation cannot mutate the thrown error's code/retryable.
    const { runInNewContext } = await import("node:vm");
    const foreignRejection = () =>
      runInNewContext("Promise.reject(new Error('foreign-hook-boom'))");
    const warnings: string[] = [];
    const mutClient = createDomainClient({
      provider: memoryProvider(),
      logger: {
        debug() {},
        info() {},
        warn(msg) {
          warnings.push(msg);
        },
        error() {},
      },
      onOperation: ((ev: { outcome: string; error?: DomainSdkError }) => {
        if (ev.error) {
          (ev.error as { code: string }).code = "TIMEOUT";
          (ev.error as { retryable: boolean }).retryable = true;
        }
        return foreignRejection();
      }) as unknown as () => void,
    });
    const missingErr = await mutClient.get("missing-r33.example.com").catch((e) => e);
    await new Promise((r) => setTimeout(r, 10));
    expect(missingErr).toBeInstanceOf(DomainSdkError);
    expect(missingErr.code).toBe("DOMAIN_NOT_FOUND");
    expect(missingErr.retryable).toBe(false);
    expect(warnings.some((w) => w.includes("onOperation hook threw"))).toBe(true);

    // 4. Per-record host pre-commit throw with concurrent foreign same-key record sets restored: true, externalChange: true.
    const prZone: ZoneRecord[] = [];
    const prErr = await createDnsClient({
      retry: { maxAttempts: 1 },
      provider: {
        id: "pr-foreign-samekey",
        capabilities: {
          wholeZoneWrites: false,
          recordTypes: ["A"],
          ttl: { min: 60, max: 86400 },
          zoneInfo: false,
        },
        async listRecords() {
          return prZone.map((r) => ({ ...r }));
        },
        async createRecords() {
          prZone.push({
            id: "f-same",
            type: "A",
            name: "app.example.com",
            value: "8.8.8.8",
            ttl: 300,
            editable: true,
          });
          throw new DomainSdkError("PROVIDER_UNAVAILABLE", "write failed before commit", {
            provider: "pr-foreign-samekey",
          });
        },
        async deleteRecords() {},
      },
    })
      .ensureRecords([{ type: "A", name: "app.example.com", value: "1.2.3.4" }], {
        zone: "example.com",
      })
      .catch((e) => e);
    expect(prErr).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: { restored: true, externalChange: true },
    });
    expect(prErr.details?.unexpected).toBeUndefined();

    // 5. Throwing restore with concurrent locked owned record preserves externalChange: true.
    const lrZone: ZoneRecord[] = [
      {
        id: "old1",
        type: "A",
        name: "app.example.com",
        value: "9.9.9.9",
        ttl: 300,
        editable: true,
      },
    ];
    let lrCreate = 0;
    const lrErr = await createDnsClient({
      retry: { maxAttempts: 1 },
      provider: {
        id: "wz-locked-concurrent",
        capabilities: {
          wholeZoneWrites: true,
          recordTypes: ["A"],
          ttl: { min: 60, max: 86400 },
          zoneInfo: false,
        },
        async listRecords() {
          return lrZone.map((r) => ({ ...r }));
        },
        async createRecords() {
          lrCreate += 1;
          if (lrCreate === 1) {
            lrZone.length = 0;
            throw new DomainSdkError("REQUEST_FAILED", "write failed", {
              provider: "wz-locked-concurrent",
            });
          }
          lrZone.push({
            id: "locked-1",
            type: "A",
            name: "app.example.com",
            value: "1.2.3.4",
            ttl: 300,
            editable: false,
          });
          throw new DomainSdkError("REQUEST_FAILED", "restore failed", {
            provider: "wz-locked-concurrent",
          });
        },
        async deleteRecords() {},
      },
    })
      .ensureRecords([{ type: "A", name: "app.example.com", value: "1.2.3.4" }], {
        zone: "example.com",
        onConflict: "replace",
      })
      .catch((e) => e);
    expect(lrErr).toMatchObject({
      code: "REQUEST_FAILED",
      details: { restored: false, externalChange: true },
    });

    // 6. Cloudflare remove() rejects dot-segment response IDs ("." / "..").
    let cfDeleteCalled = false;
    const cf = cloudflareSaaS({
      apiToken: "cf-tok",
      zoneId: "zone123",
      cnameTarget: "fallback.example.com",
      fetch: async (_url, init) => {
        if (init?.method === "DELETE") {
          cfDeleteCalled = true;
        }
        return new Response(
          JSON.stringify({
            success: true,
            result: [{ id: "..", hostname: "dot.example.com", status: "active" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const cfErr = await createDomainClient({ provider: cf, retry: { maxAttempts: 1 } })
      .remove("dot.example.com")
      .catch((e) => e);
    expect(cfErr).toBeInstanceOf(DomainSdkError);
    expect(cfDeleteCalled).toBe(false);
  });

  test("R34: cloned hook errors keep thrown errors mutable while isolating code/details, details.remaining preserves TXT values, trailing credentials redact across all prefixes, per-record replace detects external deletion, and Porkbun rejects dot IDs", async () => {
    // 1. Thrown error stays mutable (e.g. framework err.digest), while hook mutations to code/retryable/details cannot leak (including DNS failEarly).
    const domErr = await createDomainClient({
      provider: memoryProvider(),
      onOperation(ev) {
        if (ev.outcome === "failure") {
          (ev.error as { code: string }).code = "MUTATED";
          (ev.error as { retryable: boolean }).retryable = true;
          if (ev.error.details) ev.error.details.tampered = true;
        }
      },
    })
      .add("bad..host")
      .catch((e) => e);
    expect(domErr).toBeInstanceOf(DomainSdkError);
    expect(domErr.code).toBe("INVALID_HOSTNAME");
    expect(domErr.retryable).toBe(false);
    expect(Object.isFrozen(domErr)).toBe(false);
    (domErr as { digest?: string }).digest = "next-digest";
    expect((domErr as { digest?: string }).digest).toBe("next-digest");

    const dnsEarlyErr = await createDnsClient({
      provider: {
        id: "no-zone-info",
        capabilities: {
          recordTypes: ["A"],
          ttl: { min: 60, max: 3600 },
          wholeZoneWrites: false,
          zoneInfo: false,
        },
        listRecords: async () => [],
        createRecords: async () => {},
        deleteRecords: async () => {},
      },
      onOperation(ev) {
        if (ev.outcome === "failure") {
          (ev.error as { code: string }).code = "MUTATED";
          (ev.error as { retryable: boolean }).retryable = true;
        }
      },
    })
      .getZone("example.com")
      .catch((e) => e);
    expect(dnsEarlyErr).toBeInstanceOf(DomainSdkError);
    expect(dnsEarlyErr.code).toBe("UNSUPPORTED_OPERATION");
    expect(dnsEarlyErr.retryable).toBe(false);

    const conflictZone = memoryDnsProvider();
    await conflictZone.createRecords(
      { zone: "example.com", records: [{ type: "A", name: "app.example.com", value: "9.9.9.9" }] },
      { logger: {} },
    );
    const detailsIsoErr = await createDnsClient({
      provider: conflictZone,
      onOperation(ev) {
        if (ev.outcome === "failure" && ev.error.details) {
          ev.error.details.conflicts = [];
          ev.error.details.hacked = true;
        }
      },
    })
      .ensureRecords([{ type: "A", name: "app.example.com", value: "1.2.3.4" }], {
        zone: "example.com",
      })
      .catch((e) => e);
    expect(detailsIsoErr.code).toBe("DOMAIN_CONFLICT");
    expect(detailsIsoErr.details?.hacked).toBeUndefined();
    const isoConflicts = detailsIsoErr.details?.conflicts;
    expect(Array.isArray(isoConflicts) ? isoConflicts.length : 0).toBe(1);

    // 2. details.remaining preserves TXT record values.
    const remErr = new DomainSdkError("REQUEST_FAILED", "verify failed", {
      details: { remaining: [{ type: "TXT", name: "app.example.com", value: "token=abc123" }] },
    });
    expect(remErr.details).toMatchObject({
      remaining: [{ type: "TXT", name: "app.example.com", value: "token=abc123" }],
    });

    // 3. Trailing credentials after exempt words redact across all prefixes + Bearer+ form encoding.
    for (const [raw, leak] of [
      ['ApiKey : invalid "supersecret"', "supersecret"],
      ['api_key: expired "sk_live_999"', "sk_live_999"],
      ['passphrase: missing "pp_secret_42"', "pp_secret_42"],
      ['Basic: invalid "admin:s3cr3t"', "s3cr3t"],
      ["Bearer+S3CR3T_FORM_TOKEN", "S3CR3T_FORM_TOKEN"],
    ] as const) {
      const scrubbed = String(redact(raw));
      expect(scrubbed).not.toContain(leak);
      expect(scrubbed).toContain("[REDACTED]");
    }

    // 4. Per-record replace rollback detects concurrent external deletion of a pre-existing wanted record.
    const prReplaceZone: ZoneRecord[] = [
      { id: "w1", type: "TXT", name: "_v.example.com", value: "keep-me", ttl: 300, editable: true },
      { id: "c1", type: "A", name: "app.example.com", value: "9.9.9.9", ttl: 300, editable: true },
    ];
    let prCreateAttempt = 0;
    const prReplaceErr = await createDnsClient({
      retry: { maxAttempts: 1 },
      provider: {
        id: "pr-ext-del",
        capabilities: {
          wholeZoneWrites: false,
          recordTypes: ["A", "TXT"],
          ttl: { min: 60, max: 86400 },
          zoneInfo: false,
        },
        async listRecords() {
          return prReplaceZone.map((r) => ({ ...r }));
        },
        async deleteRecords({ records }) {
          for (const rec of records) {
            const idx = prReplaceZone.findIndex((r) => r.id === rec.id);
            if (idx >= 0) prReplaceZone.splice(idx, 1);
          }
        },
        async createRecords({ records }) {
          prCreateAttempt += 1;
          if (prCreateAttempt === 1) {
            // Concurrent writer deletes pre-existing wanted TXT record during failed replace.
            const wIdx = prReplaceZone.findIndex((r) => r.id === "w1");
            if (wIdx >= 0) prReplaceZone.splice(wIdx, 1);
            throw new DomainSdkError("REQUEST_FAILED", "create failed", { provider: "pr-ext-del" });
          }
          for (const rec of records) {
            prReplaceZone.push({
              id: `r-${prReplaceZone.length}`,
              type: rec.type,
              name: rec.name,
              value: rec.value,
              ttl: rec.ttl ?? 300,
              editable: true,
            });
          }
        },
      },
    })
      .ensureRecords(
        [
          { type: "TXT", name: "_v.example.com", value: "keep-me" },
          { type: "A", name: "app.example.com", value: "1.2.3.4" },
        ],
        { zone: "example.com", onConflict: "replace" },
      )
      .catch((e) => e);
    expect(prReplaceErr).toMatchObject({
      code: "REQUEST_FAILED",
      details: { restored: true, externalChange: true },
    });
    expect(prReplaceErr.message).toContain("changed concurrently");

    // 5. Porkbun deleteRecords rejects dot-segment IDs without issuing a network request.
    let pbDeleteCalled = false;
    const pb = porkbun({
      apiKey: "pk1_key",
      secretApiKey: "sk1_secret",
      fetch: async () => {
        pbDeleteCalled = true;
        return new Response(JSON.stringify({ status: "SUCCESS" }), { status: 200 });
      },
    });
    const pbErr = await pb
      .deleteRecords(
        {
          zone: "example.com",
          records: [
            { id: "..", type: "A", name: "app.example.com", value: "1.2.3.4", editable: true },
          ],
        },
        { logger: {} },
      )
      .catch((e: unknown) => e);
    expect(pbErr).toBeInstanceOf(DomainSdkError);
    expect(pbDeleteCalled).toBe(false);

    // 6. Unspaced ApiKey/Digest trailing redaction, Bearer TOKEN, bare diagnostics, API key / accessKeyId,
    // frozen cause, onConflict runtime validation, and rollback retryable flag.
    for (const [raw, leak] of [
      ['ApiKey: invalid "supersecret"', "supersecret"],
      ['ApiKey invalid "supersecret"', "supersecret"],
      ['ApiKey=invalid "supersecret"', "supersecret"],
      ["ApiKey: invalid secret_token_999", "secret_token_999"],
      ["ApiKey invalid secret_token_999", "secret_token_999"],
      ['Digest invalid "supersecret"', "supersecret"],
      ["Bearer TOKEN", "TOKEN"],
      ["Bearer+TOKEN", "TOKEN"],
      ["API key sk_live_abc12345 was rejected", "sk_live_abc12345"],
      ["accessKeyId: AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
    ] as const) {
      const scrubbed = String(redact(raw));
      expect(scrubbed).not.toContain(leak);
      expect(scrubbed).toContain("[REDACTED]");
    }
    expect(String(redact("api_key: expired"))).toBe("api_key: expired");
    expect(String(redact("ApiKey : invalid"))).toBe("ApiKey : invalid");
    expect(String(redact("passphrase: missing"))).toBe("passphrase: missing");
    expect(String(redact("The passphrase is invalid."))).toBe("The passphrase is invalid.");
    expect(String(redact("Bearer token expired"))).toBe("Bearer token expired");

    // Cause copy is frozen against hook mutation.
    const wrappedCauseErr = new DomainSdkError("REQUEST_FAILED", "failed", {
      cause: new Error("upstream boom"),
    });
    expect(Object.isFrozen(wrappedCauseErr.cause)).toBe(true);

    // Invalid onConflict rejects with INVALID_CONFIGURATION before touching the zone.
    const badConflictErr = await createDnsClient({
      provider: {
        id: "conflict-val",
        capabilities: {
          wholeZoneWrites: false,
          recordTypes: ["A"],
          ttl: { min: 60, max: 86400 },
          zoneInfo: false,
        },
        async listRecords() {
          throw new Error("should not list");
        },
        async createRecords() {},
        async deleteRecords() {},
      },
    })
      .ensureRecords([{ type: "A", name: "app.example.com", value: "1.2.3.4" }], {
        zone: "example.com",
        onConflict: "bogus" as "error",
      })
      .catch((e) => e);
    expect(badConflictErr).toMatchObject({ code: "INVALID_CONFIGURATION" });

    // Rolled-back replacements and external changes clear retryable.
    expect(prReplaceErr.retryable).toBe(false);

    // 7. Single-read onConflict getter stability, deep-frozen non-Error object cause, and asymmetric spaced-colon redaction.
    expect(String(redact('ApiKey :invalid "supersecret"'))).not.toContain("supersecret");
    const objCauseErr = new DomainSdkError("REQUEST_FAILED", "failed", {
      cause: { nested: { flag: true } },
    });
    expect(Object.isFrozen(objCauseErr.cause)).toBe(true);
    expect(Object.isFrozen((objCauseErr.cause as { nested: object }).nested)).toBe(true);

    let onConflictReads = 0;
    let conflictingDeletes = 0;
    const unstableOnConflictErr = await createDnsClient({
      provider: {
        id: "stable-conflict",
        capabilities: {
          wholeZoneWrites: false,
          recordTypes: ["A"],
          ttl: { min: 60, max: 86400 },
          zoneInfo: false,
        },
        async listRecords() {
          return [
            {
              id: "c1",
              type: "A",
              name: "app.example.com",
              value: "9.9.9.9",
              ttl: 300,
              editable: true,
            },
          ];
        },
        async deleteRecords() {
          conflictingDeletes += 1;
        },
        async createRecords() {},
      },
    })
      .ensureRecords([{ type: "A", name: "app.example.com", value: "1.2.3.4" }], {
        zone: "example.com",
        get onConflict() {
          onConflictReads += 1;
          return (onConflictReads === 1 ? "error" : "replace") as "error";
        },
      })
      .catch((e) => e);
    expect(unstableOnConflictErr).toMatchObject({ code: "DOMAIN_CONFLICT" });
    expect(onConflictReads).toBe(1);
    expect(conflictingDeletes).toBe(0);
  });
});
