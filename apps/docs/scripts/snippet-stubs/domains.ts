// The domain client a docs snippet imports as `./domains` or `@/server/domains`.
import { createDomainClient } from "@opencoredev/domain-sdk";
import { memoryProvider } from "@opencoredev/domain-sdk/testing";

export const domains = createDomainClient({ provider: memoryProvider() });
