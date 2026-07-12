import { describe, expect, test } from "bun:test";
import { createDomainClient } from "../../src";
import { netlify } from "../../src/providers/netlify";
import { json, mockFetch } from "../helpers/fetch";

function setup(initialAliases = ["existing.customer.com"]) {
  let aliases = [...initialAliases];
  const mock = mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/v1/sites/site_123/ssl")
      return json({
        state: "issued",
        domains: ["existing.customer.com"],
        created_at: "2026-01-01T00:00:00.000Z",
        expires_at: "2026-12-31T00:00:00.000Z",
      });
    if (url.pathname === "/api/v1/sites/site_123" && method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as { domain_aliases: string[] };
      aliases = body.domain_aliases;
      return json({
        id: "site_123",
        name: "domain-sdk",
        custom_domain: "primary.example.com",
        domain_aliases: aliases,
        url: "https://domain-sdk.netlify.app",
      });
    }
    if (url.pathname === "/api/v1/sites/site_123")
      return json({
        id: "site_123",
        name: "domain-sdk",
        custom_domain: "primary.example.com",
        domain_aliases: aliases,
        url: "https://domain-sdk.netlify.app",
      });
    return json({ message: `Unhandled ${method} ${url.pathname}` }, 500);
  });
  return { ...mock, aliases: () => aliases };
}

describe("Netlify adapter", () => {
  test("manages aliases without changing the primary domain", async () => {
    const mock = setup();
    const client = createDomainClient({
      provider: netlify({ accessToken: "token", siteId: "site_123", fetch: mock.fetch }),
    });

    expect((await client.get("existing.customer.com")).status).toBe("active");
    const added = await client.add("app.customer.com");
    expect(added.records[0]).toMatchObject({
      type: "CNAME",
      value: "domain-sdk.netlify.app",
    });
    expect(mock.aliases()).toEqual(["existing.customer.com", "app.customer.com"]);
    expect((await client.list({ limit: 1 })).nextCursor).toBe("1");
    await client.remove("app.customer.com");
    await client.remove("app.customer.com");
    expect(mock.aliases()).toEqual(["existing.customer.com"]);
    const patchBodies = mock.calls
      .filter((call) => call.init?.method === "PATCH")
      .map((call) => JSON.parse(String(call.init?.body)) as Record<string, unknown>);
    expect(patchBodies.every((body) => !("custom_domain" in body))).toBe(true);
  });

  test("returns an apex routing instruction", async () => {
    const mock = setup(["customer.com"]);
    const client = createDomainClient({
      provider: netlify({ accessToken: "token", siteId: "site_123", fetch: mock.fetch }),
    });
    expect((await client.get("customer.com")).records[0]).toMatchObject({
      type: "ALIAS",
      value: "apex-loadbalancer.netlify.com",
    });
  });

  test("validates configuration, cursors, and missing aliases", async () => {
    expect(() => netlify({ accessToken: "token", siteId: "" })).toThrow();
    const mock = setup();
    const client = createDomainClient({
      provider: netlify({ accessToken: "token", siteId: "site_123", fetch: mock.fetch }),
    });
    await expect(client.get("missing.customer.com")).rejects.toMatchObject({
      code: "DOMAIN_NOT_FOUND",
    });
    await expect(client.list({ cursor: "nope" })).rejects.toMatchObject({
      code: "REQUEST_FAILED",
    });
  });
});
