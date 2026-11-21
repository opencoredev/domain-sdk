// The app's database, as `@/server/database`.
import type { DomainStatus } from "@opencoredev/domain-sdk";

export interface CustomDomainRow {
  tenantId: string;
  hostname: string;
  provider: string;
  providerDomainId: string;
  status: DomainStatus;
}

export declare const database: {
  customDomains: {
    upsert(row: CustomDomainRow): Promise<void>;
  };
};
