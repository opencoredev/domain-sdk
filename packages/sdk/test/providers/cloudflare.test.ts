import { describe, expect, test } from "bun:test";
import { createDomainClient } from "../../src";
import { cloudflareSaaS } from "../../src/providers/cloudflare";
import { json, mockFetch } from "../helpers/fetch";

const hostname = {
  id: "023e105f4ecef8ad9ca31a8372d0c353",
  hostname: "app.customer.com",
  status: "pending",
  created_at: "2026-07-01T00:00:00Z",
  ownership_verification: {
    type: "txt",
    name: "_cf-custom-hostname.app.customer.com",
    value: "ownership-token",
  },
  ownership_verification_http: {
    http_url: "http://app.customer.com/.well-known/cf-custom-hostname-challenge/id",
    http_body: "body",
  },
  verification_errors: ["custom hostname does not CNAME to this zone."],
  ssl: {
    status: "pending_validation",
    validation_records: [
      {
        status: "pending",
        txt_name: "_acme-challenge.app.customer.com",
        txt_value: "certificate-token",
      },
    ],
  },
};

function setup() {
  return mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    const base = "/client/v4/zones/zone_123/custom_hostnames";
    if (url.pathname === base && method === "POST")
      return json({ success: true, errors: [], messages: [], result: hostname }, 201);
    if (url.pathname === base && url.searchParams.has("hostname"))
      return json({ success: true, errors: [], messages: [], result: [] });
    if (url.pathname === base)
      return json({
        success: true,
        errors: [],
        messages: [],
        result: [hostname],
        result_info: { page: 1, total_pages: 1 },
      });
    if (url.pathname === `${base}/${hostname.id}` && method === "DELETE")
      return json({ success: true, errors: [], messages: [], result: {} });
    if (url.pathname === `${base}/${hostname.id}`)
      return json({ success: true, errors: [], messages: [], result: hostname });
    return json(
      { success: false, errors: [{ code: 1000, message: "Unhandled" }], result: null },
      500,
    );
  });
}

describe("Cloudflare for SaaS adapter", () => {
  test("keeps ownership, certificate, and routing records distinct", async () => {
    const mock = setup();
    const client = createDomainClient({
      provider: cloudflareSaaS({
        apiToken: "token",
        zoneId: "zone_123",
        cnameTarget: "customers.example.net",
        fetch: mock.fetch,
      }),
    });
    const added = await client.add("app.customer.com");
    expect(added.status).toBe("pending_verification");
    expect(added.records.map((record) => record.purpose).sort()).toEqual([
      "certificate",
      "ownership",
      "routing",
    ]);
    expect(added.records.find((record) => record.purpose === "routing")?.value).toBe(
      "customers.example.net",
    );
    expect(added.verification.message).toContain("HTTP ownership validation");
  });

  test("lists detailed domains and removes idempotently", async () => {
    const mock = setup();
    const client = createDomainClient({
      provider: cloudflareSaaS({
        apiToken: "token",
        zoneId: "zone_123",
        cnameTarget: "target.example.net",
        fetch: mock.fetch,
      }),
    });
    expect((await client.list()).domains).toHaveLength(1);
    await client.remove("absent.customer.com");
  });

  test("maps structured errors without leaking the token", async () => {
    const mock = mockFetch(() =>
      json({ success: false, errors: [{ code: 9109, message: "Invalid access token" }] }, 403),
    );
    const client = createDomainClient({
      provider: cloudflareSaaS({
        apiToken: "top-secret",
        zoneId: "zone",
        cnameTarget: "target.example.net",
        fetch: mock.fetch,
      }),
    });
    try {
      await client.get("app.customer.com");
    } catch (error) {
      expect(error).toMatchObject({ code: "PERMISSION_DENIED" });
      expect(JSON.stringify(error)).not.toContain("top-secret");
    }
  });

  test("classifies fallback origin failures as adapter configuration", async () => {
    const mock = mockFetch(() =>
      json(
        { success: false, errors: [{ code: 1406, message: "Fallback origin is not configured" }] },
        400,
      ),
    );
    const client = createDomainClient({
      provider: cloudflareSaaS({
        apiToken: "token",
        zoneId: "zone",
        cnameTarget: "target.example.net",
        fetch: mock.fetch,
      }),
    });
    await expect(client.add("app.customer.com")).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION",
    });
  });
});
