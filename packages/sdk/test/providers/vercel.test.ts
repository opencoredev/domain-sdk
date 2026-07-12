import { describe, expect, test } from "bun:test";
import { createDomainClient } from "../../src";
import { vercel } from "../../src/providers/vercel";
import { json, mockFetch } from "../helpers/fetch";

const projectDomain = {
  name: "app.customer.com",
  apexName: "customer.com",
  projectId: "prj_123",
  verified: false,
  verification: [
    {
      type: "TXT",
      domain: "_vercel.app.customer.com",
      value: "vc-domain-verify=token",
      reason: "Pending ownership verification",
    },
  ],
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_001_000,
};
const configuration = {
  configuredBy: null,
  acceptedChallenges: [],
  recommendedIPv4: [],
  recommendedCNAME: [{ rank: 1, value: "cname.vercel-dns.com" }],
  misconfigured: true,
};

function setup(overrides?: { addStatus?: number }) {
  return mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    if (url.pathname === "/v10/projects/prj_123/domains" && method === "POST")
      return json(
        overrides?.addStatus
          ? { error: { code: "not_modified", message: "already exists" } }
          : projectDomain,
        overrides?.addStatus ?? 200,
      );
    if (url.pathname === "/v9/projects/prj_123/domains/app.customer.com/verify")
      return json({ ...projectDomain, verified: true });
    if (url.pathname === "/v9/projects/prj_123/domains/app.customer.com" && method === "DELETE")
      return json("ok");
    if (url.pathname === "/v9/projects/prj_123/domains/app.customer.com")
      return json(projectDomain);
    if (url.pathname === "/v9/projects/prj_123/domains")
      return json({ domains: [projectDomain], pagination: { count: 1, next: null, prev: null } });
    if (url.pathname === "/v6/domains/app.customer.com/config") return json(configuration);
    return json({ error: { message: `Unhandled ${method} ${url.pathname}` } }, 500);
  });
}

describe("Vercel adapter", () => {
  test("normalizes add, get, list, verify, and remove", async () => {
    const mock = setup();
    const client = createDomainClient({
      provider: vercel({
        token: "token",
        projectId: "prj_123",
        teamId: "team_123",
        fetch: mock.fetch,
      }),
    });
    const added = await client.add("app.customer.com");
    expect(added.status).toBe("pending_verification");
    expect(added.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "CNAME",
          value: "cname.vercel-dns.com",
          purpose: "routing",
        }),
        expect.objectContaining({
          type: "TXT",
          value: "vc-domain-verify=token",
          purpose: "ownership",
        }),
      ]),
    );
    expect((await client.get("app.customer.com")).status).toBe("pending_verification");
    expect((await client.list()).domains).toHaveLength(1);
    const verified = await client.verify("app.customer.com");
    expect(verified.verification.status).toBe("verified");
    await client.remove("app.customer.com");
    expect(mock.calls.every((call) => call.url.includes("teamId=team_123"))).toBe(true);
  });

  test("turns same-project duplicate add into get", async () => {
    const mock = setup({ addStatus: 400 });
    const client = createDomainClient({
      provider: vercel({ token: "secret", projectId: "prj_123", fetch: mock.fetch }),
    });
    expect((await client.add("app.customer.com")).id).toBe("prj_123:app.customer.com");
  });

  test("normalizes rate limits", async () => {
    const mock = mockFetch(() =>
      json({ error: { message: "slow down" } }, 429, { "retry-after": "3" }),
    );
    const client = createDomainClient({
      provider: vercel({ token: "secret", projectId: "prj_123", fetch: mock.fetch }),
    });
    await expect(client.get("app.customer.com")).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      retryAfter: 3000,
    });
  });

  test("normalizes authentication, provider availability, and malformed bodies", async () => {
    for (const [status, code] of [
      [401, "AUTHENTICATION_FAILED"],
      [503, "PROVIDER_UNAVAILABLE"],
    ] as const) {
      const mock = mockFetch(() => json({ error: { message: "provider failure" } }, status));
      const client = createDomainClient({
        provider: vercel({ token: "secret", projectId: "prj_123", fetch: mock.fetch }),
      });
      await expect(client.get("app.customer.com")).rejects.toMatchObject({ code });
    }
    const malformed = mockFetch((url) =>
      url.pathname.includes("/config") ? json(configuration) : json({ name: "app.customer.com" }),
    );
    const client = createDomainClient({
      provider: vercel({ token: "secret", projectId: "prj_123", fetch: malformed.fetch }),
    });
    await expect(client.get("app.customer.com")).rejects.toMatchObject({ code: "REQUEST_FAILED" });
  });

  test("does not claim a duplicate from another project", async () => {
    const mock = mockFetch((url, init) => {
      if (url.pathname === "/v10/projects/prj_123/domains" && init?.method === "POST")
        return json({ error: { code: "not_modified", message: "already exists" } }, 400);
      if (url.pathname.includes("/domains/app.customer.com"))
        return json({ ...projectDomain, projectId: "prj_other" });
      return json(configuration);
    });
    const client = createDomainClient({
      provider: vercel({ token: "secret", projectId: "prj_123", fetch: mock.fetch }),
    });
    await expect(client.add("app.customer.com")).rejects.toMatchObject({ code: "DOMAIN_CONFLICT" });
  });
});
