import { describe, expect, test } from "bun:test";
import { createDomainClient } from "../../src";
import { render } from "../../src/providers/render";
import { json, mockFetch } from "../helpers/fetch";

const pendingDomain = {
  id: "cd_123",
  name: "app.customer.com",
  domainType: "subdomain",
  publicSuffix: "com",
  redirectForName: "",
  verificationStatus: "unverified",
  createdAt: "2026-07-12T12:00:00.000Z",
};

function setup() {
  let removed = false;
  return mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    if (url.pathname === "/v1/services/srv_123")
      return json({
        id: "srv_123",
        serviceDetails: { url: "https://domain-sdk.onrender.com" },
      });
    if (url.pathname.endsWith("/custom-domains/app.customer.com/verify") && method === "POST")
      return new Response(undefined, { status: 202 });
    if (url.pathname.endsWith("/custom-domains/app.customer.com") && method === "DELETE") {
      removed = true;
      return new Response(undefined, { status: 204 });
    }
    if (url.pathname.endsWith("/custom-domains/app.customer.com"))
      return removed ? json({ message: "not found" }, 404) : json(pendingDomain);
    if (url.pathname.endsWith("/custom-domains") && method === "POST")
      return json(
        [pendingDomain, { ...pendingDomain, id: "cd_www", name: "www.app.customer.com" }],
        201,
      );
    if (url.pathname.endsWith("/custom-domains"))
      return json([{ customDomain: pendingDomain, cursor: "cursor-1" }]);
    return json({ message: `Unhandled ${method} ${url.pathname}` }, 500);
  });
}

describe("Render adapter", () => {
  test("normalizes lifecycle requests and Render DNS", async () => {
    const mock = setup();
    const client = createDomainClient({
      provider: render({ apiKey: "key", serviceId: "srv_123", fetch: mock.fetch }),
    });

    const added = await client.add("app.customer.com");
    expect(added.id).toBe("cd_123");
    expect(added.status).toBe("pending_dns");
    expect(added.records).toContainEqual(
      expect.objectContaining({
        type: "CNAME",
        name: "app.customer.com",
        value: "domain-sdk.onrender.com",
      }),
    );
    expect((await client.list()).domains).toHaveLength(1);
    expect((await client.verify("app.customer.com")).hostname).toBe("app.customer.com");
    await client.remove("app.customer.com");
    await client.remove("app.customer.com");
    expect(
      mock.calls.every((call) => call.init?.headers && String(call.init.headers).length > 0),
    ).toBe(true);
  });

  test("normalizes apex and wildcard records", async () => {
    const mock = mockFetch((url) => {
      if (url.pathname === "/v1/services/srv_123")
        return json({ serviceDetails: { url: "https://domain-sdk.onrender.com" } });
      if (url.pathname.endsWith("/customer.com"))
        return json({ ...pendingDomain, id: "apex", name: "customer.com", domainType: "apex" });
      return json({
        ...pendingDomain,
        id: "wildcard",
        name: "*.customer.com",
        domainType: "subdomain",
      });
    });
    const client = createDomainClient({
      provider: render({ apiKey: "key", serviceId: "srv_123", fetch: mock.fetch }),
    });
    expect((await client.get("customer.com")).records[0]).toMatchObject({
      type: "A",
      value: "216.24.57.1",
    });
    expect((await client.get("*.customer.com")).records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "_acme-challenge.customer.com" }),
        expect.objectContaining({ name: "_cf-custom-hostname.customer.com" }),
      ]),
    );
  });

  test("validates configuration and normalizes provider failures", async () => {
    expect(() => render({ apiKey: "", serviceId: "service" })).toThrow();
    const mock = mockFetch(() => json({ message: "slow down" }, 429, { "retry-after": "2" }));
    const client = createDomainClient({
      provider: render({ apiKey: "key", serviceId: "srv_123", fetch: mock.fetch }),
    });
    await expect(client.get("app.customer.com")).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryAfter: 2000,
    });
  });
});
