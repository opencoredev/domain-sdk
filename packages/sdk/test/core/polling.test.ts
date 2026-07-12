import { expect, test } from "bun:test";
import { createDomainClient } from "../../src";
import { memoryProvider } from "../../src/testing";

test("waitUntilActive polls sequentially and reports each status", async () => {
  const memory = memoryProvider();
  let now = 0;
  let sleeps = 0;
  const client = createDomainClient({
    provider: memory,
    clock: {
      now: () => now,
      async sleep(ms) {
        sleeps += 1;
        now += ms;
        memory.activate("app.customer.com");
      },
    },
  });
  await client.add("app.customer.com");
  const statuses: string[] = [];
  const active = await client.waitUntilActive("app.customer.com", {
    timeoutMs: 10_000,
    intervalMs: 500,
    onStatus: (domain) => statuses.push(domain.status),
  });
  expect(active.status).toBe("active");
  expect(statuses).toEqual(["pending_dns", "active"]);
  expect(sleeps).toBe(1);
  expect(memory.calls.filter((call) => call.operation === "get")).toHaveLength(2);
});
