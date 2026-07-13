import {
  createDomainClient,
  createSubdomainClient,
  DomainSdkError,
  type Domain,
  type DomainProvider,
} from "@opencoredev/domain-sdk";
import { cloudflareSaaS } from "@opencoredev/domain-sdk/cloudflare";
import { railway } from "@opencoredev/domain-sdk/railway";
import { createMockDomain, memoryProvider } from "@opencoredev/domain-sdk/testing";
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
void result;
void tenantHostname;
void mock;
void DomainSdkError;
