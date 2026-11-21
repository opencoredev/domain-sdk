// Load every built entry with Node.js built-ins blocked and Node-only globals removed, then run
// a real client flow. Prints one JSON line for the test to check.
globalThis.Buffer = undefined;
globalThis.require = undefined;

const entries = [
  "@opencoredev/domain-sdk",
  "@opencoredev/domain-sdk/vercel",
  "@opencoredev/domain-sdk/cloudflare",
  "@opencoredev/domain-sdk/railway",
  "@opencoredev/domain-sdk/render",
  "@opencoredev/domain-sdk/netlify",
  "@opencoredev/domain-sdk/bunny",
  "@opencoredev/domain-sdk/porkbun",
  "@opencoredev/domain-sdk/namecheap",
  "@opencoredev/domain-sdk/spaceship",
  "@opencoredev/domain-sdk/testing",
];
const loaded = [];
for (const entry of entries) {
  await import(entry);
  loaded.push(entry);
}
const { createDnsClient, createDomainClient } = await import("@opencoredev/domain-sdk");
const { memoryDnsProvider, memoryProvider } = await import("@opencoredev/domain-sdk/testing");
const domains = createDomainClient({ provider: memoryProvider({ initialStatus: "active" }) });
const domain = await domains.add("app.customer.com");
const dns = createDnsClient({ provider: memoryDnsProvider() });
const records = await dns.applyDomainRecords(domain, { zone: "customer.com" });
console.log(JSON.stringify({ loaded, status: domain.status, records: records.length }));
