import {
  createDomainClient,
  createSubdomainClient,
  DomainSdkError,
  type Domain,
  type DnsClient,
  type DnsProvider,
  type DomainProvider,
  type ZoneRecord,
  createDnsClient,
} from "@opencoredev/domain-sdk";
import { cloudflareSaaS } from "@opencoredev/domain-sdk/cloudflare";
import { porkbun } from "@opencoredev/domain-sdk/porkbun";
import { railway } from "@opencoredev/domain-sdk/railway";
import {
  createMockDomain,
  memoryDnsProvider,
  memoryProvider,
} from "@opencoredev/domain-sdk/testing";
import { vercel } from "@opencoredev/domain-sdk/vercel";

const providers: DomainProvider[] = [
  vercel({ token: "test", projectId: "project" }),
  cloudflareSaaS({ apiToken: "test", zoneId: "zone", cnameTarget: "target.example.com" }),
  railway({
    token: "test",
    projectId: "project",
    environmentId: "environment",
    serviceId: "service",
  }),
  memoryProvider(),
];

const client = createDomainClient({ provider: providers[3]! });
const subdomains = createSubdomainClient({ domainClient: client, baseDomain: "example.com" });
const result: Promise<Domain> = client.add("app.customer.com");
const tenantHostname: string = subdomains.toHostname("tenant");
const mock: Domain = createMockDomain();
const dnsProviders: DnsProvider[] = [
  porkbun({ apiKey: "test", secretApiKey: "test" }),
  memoryDnsProvider(),
];
const dns: DnsClient = createDnsClient({ provider: dnsProviders[0]! });
const records: Promise<ZoneRecord[]> = dns.ensureRecords([
  { type: "CNAME", name: "app.example.com", value: "cname.vercel-dns.com" },
]);
void result;
void records;
void tenantHostname;
void mock;
void DomainSdkError;
