import { describe, expect, test } from "bun:test";
import { createDomainClient, type DomainProvider } from "../../src";
import { memoryProvider } from "../../src/testing";

function providerContract(name: string, create: () => DomainProvider) {
  describe(`${name} provider contract`, () => {
    test("add/get/list/verify/remove lifecycle is idempotent", async () => {
      const client = createDomainClient({ provider: create() });
      const first = await client.add("app.customer.com");
      expect((await client.add("app.customer.com")).id).toBe(first.id);
      expect((await client.get("app.customer.com")).hostname).toBe("app.customer.com");
      expect((await client.list()).domains).toHaveLength(1);
      expect((await client.verify("app.customer.com")).status).toBe("active");
      await client.remove("app.customer.com");
      await client.remove("app.customer.com");
      await expect(client.get("app.customer.com")).rejects.toMatchObject({
        code: "DOMAIN_NOT_FOUND",
      });
    });
  });
}

providerContract("memory", () => memoryProvider());
