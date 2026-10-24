import { describe, expect, test } from "bun:test";
import { createDomainClient } from "../../src";
import { railway } from "../../src/providers/railway";
import { json, mockFetch } from "../helpers/fetch";

const summary = {
  id: "domain_123",
  domain: "app.customer.com",
  status: {
    verificationToken: "railway-verify=token",
    dnsRecords: [
      {
        hostlabel: "app",
        requiredValue: "abc.up.railway.app",
        currentValue: null,
        status: "PENDING",
      },
    ],
  },
};
const details = { ...summary, status: { ...summary.status, certificateStatus: "PENDING" } };

function setup(graphqlErrors = false) {
  return mockFetch(async (_url, init) => {
    const payload = JSON.parse(String(init?.body)) as { query: string };
    if (graphqlErrors)
      return json({
        data: null,
        errors: [{ message: "Not authorized", extensions: { code: "FORBIDDEN" } }],
      });
    if (payload.query.includes("DomainSdkCustomDomainAvailable"))
      return json({ data: { customDomainAvailable: { available: true, message: null } } });
    if (payload.query.includes("DomainSdkCustomDomainCreate"))
      return json({ data: { customDomainCreate: details } });
    if (payload.query.includes("DomainSdkCustomDomainDelete"))
      return json({ data: { customDomainDelete: true } });
    if (payload.query.includes("DomainSdkCustomDomain("))
      return json({ data: { customDomain: details } });
    if (payload.query.includes("DomainSdkDomains"))
      return json({ data: { domains: { customDomains: [] } } });
    return json({ errors: [{ message: "Unknown operation" }] });
  });
}

describe("Railway adapter", () => {
  test("uses current named GraphQL operations and requires routing plus TXT", async () => {
    const mock = setup();
    const client = createDomainClient({
      provider: railway({
        token: "token",
        projectId: "project",
        environmentId: "environment",
        serviceId: "service",
        fetch: mock.fetch,
      }),
    });
    const added = await client.add("app.customer.com");
    expect(added.status).toBe("pending_dns");
    expect(added.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "CNAME",
          name: "app.customer.com",
          value: "abc.up.railway.app",
          purpose: "routing",
        }),
        expect.objectContaining({
          type: "TXT",
          name: "_railway-verify.app.customer.com",
          value: "railway-verify=token",
          purpose: "ownership",
        }),
      ]),
    );
    const operations = mock.calls.map(
      (call) => JSON.parse(String(call.init?.body)) as { query: string },
    );
    expect(operations.some((item) => item.query.includes("customDomainAvailable"))).toBe(true);
    expect(operations.some((item) => item.query.includes("customDomainCreate"))).toBe(true);
  });

  test("lists full domains from one GraphQL query", async () => {
    const mock = mockFetch(async (_url, init) => {
      const payload = JSON.parse(String(init?.body)) as { query: string };
      if (payload.query.includes("DomainSdkDomains"))
        return json({
          data: {
            domains: {
              customDomains: [
                details,
                { ...details, id: "domain_456", domain: "www.customer.com" },
              ],
            },
          },
        });
      return json({ errors: [{ message: "Unexpected operation" }] });
    });
    const provider = railway({
      token: "token",
      projectId: "project",
      environmentId: "environment",
      serviceId: "service",
      fetch: mock.fetch,
    });
    const page = await provider.list!({ limit: 10 }, { logger: {} });
    expect(page.domains.map((domain) => domain.hostname)).toEqual([
      "app.customer.com",
      "www.customer.com",
    ]);
    expect(page.domains[0]?.status).toBe("pending_dns");
    expect(mock.calls).toHaveLength(1);
    const operation = JSON.parse(String(mock.calls[0]?.init?.body)) as { query: string };
    expect(operation.query).toContain("certificateStatus");
  });

  test("detects GraphQL errors returned with HTTP 200", async () => {
    const mock = setup(true);
    const client = createDomainClient({
      provider: railway({
        token: "token",
        projectId: "project",
        environmentId: "environment",
        serviceId: "service",
        fetch: mock.fetch,
      }),
    });
    await expect(client.get("app.customer.com")).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
      provider: "railway",
    });
  });

  test("validates required IDs at construction", () => {
    expect(() =>
      railway({ token: "token", projectId: "", environmentId: "env", serviceId: "svc" }),
    ).toThrow();
  });
});
