import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli/run";
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
import { memoryDnsProvider } from "../src/testing";

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
  });
});
