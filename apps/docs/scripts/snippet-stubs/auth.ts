// The app's tenant authorization, as `@/server/auth`.
export interface Tenant {
  readonly id: string;
  assertCanManageDomains(): Promise<void>;
}

export declare function requireTenant(request: Request): Promise<Tenant>;
