import { describe, expect, test } from "bun:test";

import { createDnsClient, type DnsProvider, type ZoneRecord } from "../src/core/dns";
import { DomainSdkError } from "../src/core/errors";
import { namecheap } from "../src/providers/namecheap";
import { porkbun } from "../src/providers/porkbun";
import { json, mockFetch } from "./helpers/fetch";

interface NamecheapHost {
  HostId: string;
  Name: string;
  Type: string;
  Address: string;
  TTL: string;
}

/** A Namecheap API whose zone another writer can edit right after the SDK's first read. */
function namecheapApi(initial: Omit<NamecheapHost, "HostId">[]) {
  let hosts: NamecheapHost[] = initial.map((host, index) => ({
    ...host,
    HostId: String(index + 1),
  }));
  let nextId = hosts.length + 1;
  let reads = 0;
  let afterFirstRead: ((current: NamecheapHost[]) => NamecheapHost[]) | undefined;
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  const xml = (content: string) =>
    new Response(
      `<?xml version="1.0"?><ApiResponse Status="OK"><Errors/><CommandResponse>${content}</CommandResponse></ApiResponse>`,
    );
  const mock = mockFetch((_url, init) => {
    const form = new URLSearchParams(String(init?.body));
    const command = form.get("Command");
    if (command === "namecheap.domains.dns.getHosts") {
      const body = xml(
        `<DomainDNSGetHostsResult Domain="example.com" EmailType="MX" IsUsingOurDNS="true">${hosts
          .map(
            (host) =>
              `<host ${Object.entries(host)
                .map(([key, value]) => `${key}="${escape(value)}"`)
                .join(" ")}/>`,
          )
          .join("")}</DomainDNSGetHostsResult>`,
      );
      if (++reads === 1 && afterFirstRead) hosts = afterFirstRead(hosts);
      return body;
    }
    if (command === "namecheap.domains.dns.setHosts") {
      const next: NamecheapHost[] = [];
      for (let index = 1; form.has(`HostName${index}`); index++)
        next.push({
          HostId: String(nextId++),
          Name: form.get(`HostName${index}`)!,
          Type: form.get(`RecordType${index}`)!,
          Address: form.get(`Address${index}`)!,
          TTL: form.get(`TTL${index}`)!,
        });
      hosts = next;
      return xml(`<DomainDNSSetHostsResult Domain="example.com" IsSuccess="true"/>`);
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  return {
    provider: namecheap({
      apiUser: "account",
      apiKey: "secret-key",
      clientIp: "192.0.2.10",
      fetch: mock.fetch,
    }),
    hosts: () => hosts.map(({ Name, Type, Address }) => `${Type} ${Name} ${Address}`).sort(),
    editAfterFirstRead(edit: (current: NamecheapHost[]) => NamecheapHost[]) {
      afterFirstRead = edit;
    },
  };
}

describe("DNS rollback uses the zone the write was built from", () => {
  test("a record deleted elsewhere before Namecheap's own read is not restored", async () => {
    const api = namecheapApi([
      { Name: "@", Type: "A", Address: "192.0.2.1", TTL: "1800" },
      { Name: "old", Type: "TXT", Address: "stale", TTL: "1800" },
    ]);
    api.editAfterFirstRead((hosts) => hosts.filter((host) => host.Name !== "old"));
    const records = await createDnsClient({ provider: api.provider }).ensureRecords(
      [{ type: "TXT", name: "_verify.example.com", value: "token" }],
      { zone: "example.com" },
    );
    expect(records.map((record) => record.value)).toEqual(["token"]);
    expect(api.hosts()).toEqual(["A @ 192.0.2.1", "TXT _verify token"]);
  });

  test("an address replaced elsewhere before Namecheap's own read is not resurrected", async () => {
    const api = namecheapApi([
      { Name: "shop", Type: "A", Address: "192.0.2.10", TTL: "1800" },
      { Name: "app", Type: "A", Address: "192.0.2.1", TTL: "1800" },
    ]);
    api.editAfterFirstRead((hosts) =>
      hosts.map((host) => (host.Name === "shop" ? { ...host, Address: "192.0.2.20" } : host)),
    );
    await createDnsClient({ provider: api.provider }).ensureRecords(
      [{ type: "A", name: "app.example.com", value: "192.0.2.2" }],
      { zone: "example.com", onConflict: "replace" },
    );
    expect(api.hosts()).toEqual(["A app 192.0.2.2", "A shop 192.0.2.20"]);
  });

  test("a whole-zone delete that applied but lost its response restores the old route", async () => {
    let zone: ZoneRecord[] = [
      { id: "1", type: "A", name: "app.example.com", value: "192.0.2.1", ttl: 300, editable: true },
    ];
    const provider: DnsProvider = {
      id: "whole-zone",
      capabilities: {
        recordTypes: ["A"],
        ttl: { min: 60, max: 86400 },
        wholeZoneWrites: true,
        zoneInfo: false,
      },
      async listRecords() {
        return zone.map((record) => ({ ...record }));
      },
      async deleteRecords({ records }) {
        zone = zone.filter((record) => !records.some((target) => target.value === record.value));
        // The write applied, then the connection dropped before any response arrived.
        throw new DomainSdkError("PROVIDER_UNAVAILABLE", "connection reset", {
          provider: "whole-zone",
          retryable: true,
        });
      },
      async createRecords({ records }) {
        for (const record of records)
          zone.push({ id: String(zone.length + 2), editable: true, ttl: 300, ...record });
      },
    };
    const error = await createDnsClient({ provider, retry: { maxAttempts: 1 } })
      .ensureRecords([{ type: "A", name: "app.example.com", value: "192.0.2.2" }], {
        zone: "example.com",
        onConflict: "replace",
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "PROVIDER_UNAVAILABLE", details: { restored: true } });
    expect(zone.map((record) => record.value)).toEqual(["192.0.2.1"]);
  });
});

describe("DNS rollback only deletes records the SDK created", () => {
  test("a Porkbun create rejected with 429 never deletes another writer's identical record", async () => {
    const records: { id: string; name: string; type: string; content: string; ttl: string }[] = [];
    const mock = mockFetch((url) => {
      const path = url.pathname.replace("/api/json/v3", "");
      if (path === "/dns/retrieve/example.com") return json({ status: "SUCCESS", records });
      if (path === "/dns/create/example.com") {
        // Another worker creates the same CNAME, then Porkbun rate-limits this one.
        records.push({
          id: "other",
          name: "app.example.com",
          type: "CNAME",
          content: "target.example.net",
          ttl: "600",
        });
        return json({ status: "ERROR", message: "Rate limit exceeded" }, 429);
      }
      if (path.startsWith("/dns/delete/example.com/")) {
        const id = decodeURIComponent(path.split("/").at(-1)!);
        records.splice(
          records.findIndex((record) => record.id === id),
          1,
        );
        return json({ status: "SUCCESS" });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const error = await createDnsClient({
      provider: porkbun({ apiKey: "pk1_test", secretApiKey: "sk1_test", fetch: mock.fetch }),
      retry: { maxAttempts: 1 },
    })
      .ensureRecords([{ type: "CNAME", name: "app.example.com", value: "target.example.net" }], {
        zone: "example.com",
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "RATE_LIMITED", details: { externalChange: true } });
    expect(records.map((record) => record.id)).toEqual(["other"]);
    expect(mock.calls.some((call) => call.url.includes("/dns/delete/"))).toBe(false);
  });

  test("a Porkbun batch that fails partway deletes only the records it created", async () => {
    const records: { id: string; name: string; type: string; content: string; ttl: string }[] = [];
    let creates = 0;
    const mock = mockFetch((url, init) => {
      const path = url.pathname.replace("/api/json/v3", "");
      const body = JSON.parse(String(init?.body));
      if (path === "/dns/retrieve/example.com") return json({ status: "SUCCESS", records });
      if (path === "/dns/create/example.com") {
        if (++creates === 2) return json({ status: "ERROR", message: "Rate limit" }, 429);
        records.push({
          id: `own${creates}`,
          name: `${body.name}.example.com`,
          type: body.type,
          content: body.content,
          ttl: String(body.ttl),
        });
        return json({ status: "SUCCESS", id: `own${creates}` });
      }
      if (path.startsWith("/dns/delete/example.com/")) {
        const id = decodeURIComponent(path.split("/").at(-1)!);
        records.splice(
          records.findIndex((record) => record.id === id),
          1,
        );
        return json({ status: "SUCCESS" });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const error = await createDnsClient({
      provider: porkbun({ apiKey: "pk1_test", secretApiKey: "sk1_test", fetch: mock.fetch }),
      retry: { maxAttempts: 1 },
    })
      .ensureRecords(
        [
          { type: "TXT", name: "a.example.com", value: "one" },
          { type: "TXT", name: "b.example.com", value: "two" },
          { type: "TXT", name: "c.example.com", value: "three" },
        ],
        { zone: "example.com" },
      )
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "RATE_LIMITED", details: { restored: true } });
    expect(records).toEqual([]);
    expect(creates).toBe(2);
  });
});

describe("DNS rollback control fields survive large provider details", () => {
  test("a replacement whose error carries 50 diagnostic fields is not retried", async () => {
    let zone: ZoneRecord[] = [
      { id: "1", type: "A", name: "app.example.com", value: "192.0.2.1", ttl: 300, editable: true },
    ];
    let creates = 0;
    const provider: DnsProvider = {
      id: "noisy",
      capabilities: {
        recordTypes: ["A"],
        ttl: { min: 60, max: 86400 },
        wholeZoneWrites: false,
        zoneInfo: false,
      },
      async listRecords() {
        return zone.map((record) => ({ ...record }));
      },
      async deleteRecords({ records }) {
        zone = zone.filter((record) => !records.some((target) => target.id === record.id));
      },
      async createRecords({ records }) {
        creates += 1;
        if (records.some((record) => record.value === "192.0.2.2"))
          throw new DomainSdkError("PROVIDER_UNAVAILABLE", "busy", {
            provider: "noisy",
            retryable: true,
            details: Object.fromEntries(
              Array.from({ length: 50 }, (_, index) => [`field${index}`, index]),
            ),
          });
        for (const record of records)
          zone.push({ id: String(zone.length + 2), editable: true, ttl: 300, ...record });
      },
    };
    const error = await createDnsClient({
      provider,
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    })
      .ensureRecords([{ type: "A", name: "app.example.com", value: "192.0.2.2" }], {
        zone: "example.com",
        onConflict: "replace",
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: { restored: true, replaced: [{ type: "A", value: "192.0.2.1" }] },
    });
    // One failed replacement create plus the rollback's restore; no second replacement attempt.
    expect(creates).toBe(2);
    expect(zone.map((record) => record.value)).toEqual(["192.0.2.1"]);
  });
});
