import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runCli, type CliIo } from "../src/cli/run";
import { memoryProvider } from "../src/testing";
import { json, mockFetch } from "./helpers/fetch";

function harness(overrides: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const memory = memoryProvider();
  const io: CliIo = {
    env: {},
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    providers: { memory: { required: [], create: () => memory } },
    ...overrides,
  };
  return {
    memory,
    run: (...argv: string[]) => runCli(argv, io),
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    clear: () => {
      out.length = 0;
      err.length = 0;
    },
  };
}

describe("domain-sdk CLI usage", () => {
  test("--help prints usage and exits 0", async () => {
    const cli = harness();
    expect(await cli.run("--help")).toBe(0);
    expect(cli.stdout()).toContain("Usage: domain-sdk <command>");
    expect(cli.stdout()).toContain("vercel, cloudflare, railway, render, netlify, bunny");
  });

  test("invalid command lines exit 2 with a reason", async () => {
    const cases: [string[], string][] = [
      [[], "Usage: domain-sdk"],
      [["launch"], "Unknown command launch."],
      [["get", "--provider", "memory", "--verbose"], "Unknown option --verbose."],
      [["get", "--provider"], "--provider needs a value."],
      [["get", "--provider", "memory"], "get needs a hostname."],
      [["get", "a.example.com", "b.example.com", "--provider", "memory"], "Unexpected argument"],
      [["list", "--provider", "memory", "--limit", "ten"], "--limit must be a whole number."],
      [["get", "app.example.com"], "Pass --provider or set DOMAIN_SDK_PROVIDER."],
      [["get", "app.example.com", "--provider", "nope"], "Unknown provider nope."],
    ];
    for (const [argv, message] of cases) {
      const cli = harness();
      expect({ argv, code: await cli.run(...argv) }).toEqual({ argv, code: 2 });
      expect(cli.stderr()).toContain(message);
    }
  });

  test("names the missing environment variables for a provider", async () => {
    const cli = harness({ env: { VERCEL_TOKEN: "token" } });
    expect(await cli.run("get", "app.example.com", "--provider=vercel")).toBe(2);
    expect(cli.stderr()).toContain(
      "The vercel provider needs these environment variables: VERCEL_PROJECT_ID.",
    );
  });
});

describe("domain-sdk CLI commands", () => {
  test("rejects an unknown RAILWAY_TOKEN_TYPE instead of falling back to bearer", async () => {
    const cli = harness({
      env: {
        RAILWAY_TOKEN: "token",
        RAILWAY_TOKEN_TYPE: "projct",
        RAILWAY_PROJECT_ID: "project",
        RAILWAY_ENVIRONMENT_ID: "environment",
        RAILWAY_SERVICE_ID: "service",
      },
      fetch: () => Promise.reject(new Error("no request should be sent")),
    });
    expect(await cli.run("get", "app.example.com", "--provider", "railway")).toBe(1);
    expect(cli.stderr()).toContain("Error INVALID_CONFIGURATION: RAILWAY_TOKEN_TYPE must be");
  });

  test("runs the lifecycle with human-readable output", async () => {
    const cli = harness({ env: { DOMAIN_SDK_PROVIDER: "memory" } });
    expect(await cli.run("add", "App.Customer.com")).toBe(0);
    expect(cli.stdout()).toContain("app.customer.com  pending_dns");
    expect(cli.stdout()).toContain("DNS records:");
    expect(cli.stdout()).toMatch(/CNAME\s+app\.customer\.com/);
    cli.clear();

    expect(await cli.run("list")).toBe(0);
    expect(cli.stdout()).toBe("app.customer.com  pending_dns\n");
    cli.clear();

    expect(await cli.run("verify", "app.customer.com")).toBe(0);
    expect(cli.stdout()).toContain("app.customer.com  active");
    cli.clear();

    expect(await cli.run("wait", "app.customer.com", "--timeout-ms", "0")).toBe(0);
    expect(cli.stderr()).toBe("app.customer.com: active\n");
    cli.clear();

    expect(await cli.run("remove", "app.customer.com")).toBe(0);
    expect(cli.stdout()).toBe("Removed app.customer.com.\n");
    expect(cli.memory.calls.map((call) => call.operation)).toEqual([
      "add",
      "list",
      "verify",
      "get",
      "remove",
    ]);
  });

  test("--json prints parseable domains, pages, and removals", async () => {
    const cli = harness();
    await cli.run("add", "a.example.com", "--provider", "memory");
    await cli.run("add", "b.example.com", "--provider", "memory");
    cli.clear();

    expect(await cli.run("get", "a.example.com", "--provider", "memory", "--json")).toBe(0);
    expect(JSON.parse(cli.stdout())).toMatchObject({
      hostname: "a.example.com",
      status: "pending_dns",
    });
    cli.clear();

    expect(await cli.run("list", "--provider", "memory", "--json", "--limit", "1")).toBe(0);
    const page = JSON.parse(cli.stdout()) as {
      domains: { hostname: string }[];
      nextCursor: string;
    };
    expect(page.domains.map((domain) => domain.hostname)).toEqual(["a.example.com"]);
    expect(page.nextCursor).toBe("1");
    cli.clear();

    expect(
      await cli.run("list", "--provider", "memory", "--cursor", page.nextCursor, "--limit=1"),
    ).toBe(0);
    expect(cli.stdout()).toBe("b.example.com  pending_dns\n");
    cli.clear();

    expect(await cli.run("remove", "a.example.com", "--provider", "memory", "--json")).toBe(0);
    expect(JSON.parse(cli.stdout())).toEqual({ hostname: "a.example.com", removed: true });
  });

  test("operation failures exit 1 with the SDK error code", async () => {
    const cli = harness();
    expect(await cli.run("get", "missing.example.com", "--provider", "memory")).toBe(1);
    expect(cli.stderr()).toBe("Error DOMAIN_NOT_FOUND: missing.example.com is not configured.\n");
    cli.clear();

    expect(await cli.run("get", "missing.example.com", "--provider", "memory", "--json")).toBe(1);
    expect(JSON.parse(cli.stderr())).toMatchObject({
      error: { code: "DOMAIN_NOT_FOUND", provider: "memory", retryable: false },
    });
    cli.clear();

    expect(await cli.run("get", "not a hostname", "--provider", "memory")).toBe(1);
    expect(cli.stderr()).toContain("Error INVALID_HOSTNAME:");
  });

  test("cancels through the signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const cli = harness({ signal: controller.signal });
    expect(await cli.run("add", "app.example.com", "--provider", "memory")).toBe(1);
    expect(cli.stderr()).toContain("Error ABORTED:");
  });

  test("builds a real adapter from environment variables", async () => {
    let aliases: string[] = [];
    const mock = mockFetch((url, init) => {
      if (url.pathname.endsWith("/ssl")) return json({ message: "Not found" }, 404);
      if (init?.method === "PATCH")
        aliases = (JSON.parse(String(init.body)) as { domain_aliases: string[] }).domain_aliases;
      return json({
        id: "site_123",
        name: "domain-sdk",
        domain_aliases: aliases,
        url: "https://domain-sdk.netlify.app",
      });
    });
    const cli = harness({
      env: { NETLIFY_ACCESS_TOKEN: "secret-token", NETLIFY_SITE_ID: "site_123" },
      fetch: mock.fetch,
    });
    expect(await cli.run("add", "app.customer.com", "--provider", "netlify")).toBe(0);
    expect(cli.stdout()).toMatch(/CNAME\s+app\.customer\.com {2}domain-sdk\.netlify\.app/);
    expect(aliases).toEqual(["app.customer.com"]);
    expect(mock.calls[0]?.url).toBe("https://api.netlify.com/api/v1/sites/site_123");
    expect(cli.stdout() + cli.stderr()).not.toContain("secret-token");
  });

  test("deduplicates records shared between domain.records and verification.records", async () => {
    const shared = {
      type: "TXT" as const,
      name: "_verify.app.customer.com",
      value: "vc-domain-verify=123",
      required: true,
      purpose: "ownership" as const,
      status: "pending" as const,
    };
    const memory = memoryProvider({ records: [shared] });
    const baseGet = memory.get.bind(memory);
    memory.get = async (input, ctx) => {
      const domain = await baseGet(input, ctx);
      return { ...domain, verification: { ...domain.verification, records: [shared] } };
    };
    const cli = harness({ providers: { memory: { required: [], create: () => memory } } });
    expect(await cli.run("add", "app.customer.com", "--provider", "memory")).toBe(0);
    cli.clear();
    expect(await cli.run("get", "app.customer.com", "--provider", "memory")).toBe(0);
    expect(cli.stdout().match(/vc-domain-verify=123/g)).toHaveLength(1);
  });

  test("validates numeric CLI flag ranges as exit 2 and formats usage errors as JSON with --json", async () => {
    const cli = harness();
    expect(await cli.run("list", "--provider", "memory", "--limit", "0", "--json")).toBe(2);
    expect(JSON.parse(cli.stderr())).toMatchObject({ error: { code: "USAGE" } });
    cli.clear();

    let seenCursor: string | undefined;
    const base = memoryProvider();
    const cursorCli = harness({
      providers: {
        memory: {
          required: [],
          create: () => ({
            ...base,
            list: async (input) => {
              seenCursor = input.cursor;
              return { domains: [] };
            },
          }),
        },
      },
    });
    expect(await cursorCli.run("list", "--provider", "memory", "--cursor=--opaque")).toBe(0);
    expect(seenCursor).toBe("--opaque");

    expect(await cli.run("get", "app.example.com", "--provider", "vercel", "--json")).toBe(2);
    expect(JSON.parse(cli.stderr())).toMatchObject({ error: { code: "USAGE" } });
    cli.clear();

    expect(await cli.run("--json")).toBe(2);
    expect(JSON.parse(cli.stderr())).toMatchObject({ error: { code: "USAGE" } });
  });
});

describe("domain-sdk CLI human output", () => {
  const pagedCli = (nextCursor: string, hostnames: string[] = []) => {
    const base = memoryProvider();
    return harness({
      providers: {
        memory: {
          required: [],
          create: () => ({
            ...base,
            list: async () => ({
              domains: await Promise.all(
                hostnames.map((hostname) => base.add({ hostname }, { logger: {} })),
              ),
              nextCursor,
            }),
          }),
        },
      },
    });
  };

  test("an empty page still prints the continuation cursor", async () => {
    const cli = pagedCli("abc123");
    expect(await cli.run("list", "--provider", "memory")).toBe(0);
    expect(cli.stdout()).toBe("No domains.\n\nMore results: --cursor=abc123\n");
  });

  test("prints a cursor that the CLI parses back exactly", async () => {
    for (const cursor of ["--opaque", "a b'c", "x;$(y)"]) {
      const cli = pagedCli(cursor, ["app.example.com"]);
      expect(await cli.run("list", "--provider", "memory")).toBe(0);
      const hint = /More results: (.*)\n$/.exec(cli.stdout())?.[1] ?? "";
      expect(hint.startsWith("--cursor=")).toBe(true);
      const quoted = hint.slice("--cursor=".length);
      const unquoted = quoted.startsWith("'")
        ? quoted.slice(1, -1).replaceAll("'\\''", "'")
        : quoted;
      expect(unquoted).toBe(cursor);
    }
  });

  test("prints a DNS record's description under it", async () => {
    const base = memoryProvider();
    const cli = harness({
      providers: {
        memory: {
          required: [],
          create: () => ({
            ...base,
            get: async (input, context) => {
              const domain = await base.add(input, context);
              return {
                ...domain,
                records: [
                  {
                    type: "ALIAS",
                    name: "example.com",
                    value: "apex.netlify.com",
                    purpose: "routing",
                    required: true,
                    status: "pending",
                    description: "Or use an A record pointing to 75.2.60.5.",
                  },
                ],
              };
            },
          }),
        },
      },
    });
    expect(await cli.run("get", "example.com", "--provider", "memory")).toBe(0);
    expect(cli.stdout()).toContain("Or use an A record pointing to 75.2.60.5.");
  });
});

describe("built domain-sdk bin", () => {
  const bin = join(import.meta.dir, "..", "dist", "cli.js");

  test("runs under Node with usage and configuration exit codes", () => {
    const help = Bun.spawnSync(["node", bin, "--help"], { stdout: "pipe", stderr: "pipe" });
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain("Usage: domain-sdk");
    const missing = Bun.spawnSync(["node", bin, "get", "app.example.com", "--provider", "render"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr.toString()).toContain("RENDER_API_KEY, RENDER_SERVICE_ID");
  });
});
