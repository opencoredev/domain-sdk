// The DNS client a docs snippet imports as `./dns`.
import { createDnsClient } from "@opencoredev/domain-sdk";
import { memoryDnsProvider } from "@opencoredev/domain-sdk/testing";

export const dns = createDnsClient({ provider: memoryDnsProvider() });
