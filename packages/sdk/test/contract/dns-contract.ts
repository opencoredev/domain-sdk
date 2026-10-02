import { describe, expect, test } from "bun:test";
import { createDnsClient, type DnsProvider } from "../../src";

/**
 * Lifecycle contract every DNS adapter must pass. `create` returns a provider whose zone
 * `example.com` starts empty and is authoritative.
 */
export function dnsProviderContract(name: string, create: () => DnsProvider) {
  describe(`${name} DNS provider contract`, () => {
    test("ensure/list/remove is idempotent", async () => {
      const dns = createDnsClient({ provider: create() });
      const records = [
        { type: "CNAME" as const, name: "app.example.com", value: "cname.vercel-dns.com." },
        { type: "TXT" as const, name: "_vercel.example.com", value: "vc-domain-verify=app,abc" },
      ];
      const first = await dns.ensureRecords(records);
      expect(first).toHaveLength(2);
      const again = await dns.ensureRecords(records);
      expect(again.map((record) => record.id).sort()).toEqual(
        first.map((record) => record.id).sort(),
      );
      expect(await dns.listRecords("example.com")).toHaveLength(2);
      await dns.removeRecords(records);
      await dns.removeRecords(records);
      expect(await dns.listRecords("example.com")).toHaveLength(0);
    });

    test("conflicting routing records require onConflict: replace", async () => {
      const dns = createDnsClient({ provider: create() });
      await dns.ensureRecords([{ type: "A", name: "@", value: "192.0.2.1" }], {
        zone: "example.com",
      });
      const wanted = [{ type: "A" as const, name: "example.com", value: "76.76.21.21" }];
      await expect(dns.ensureRecords(wanted)).rejects.toMatchObject({ code: "DOMAIN_CONFLICT" });
      const [record] = await dns.ensureRecords(wanted, { onConflict: "replace" });
      expect(record).toMatchObject({ type: "A", name: "example.com", value: "76.76.21.21" });
      expect(await dns.listRecords("example.com")).toHaveLength(1);
    });
  });
}
