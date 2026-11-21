// Local constants instead of `export { x } from`: see the note in ../index.ts.
import { createMockDnsRecord as mockDnsRecord, createMockDomain as mockDomain } from "./factories";
import { memoryDnsProvider as memoryDns } from "./memory-dns-provider";
import {
  createFailingProvider as failingProvider,
  memoryProvider as memory,
} from "./memory-provider";

export const createFailingProvider: typeof failingProvider = failingProvider;
export const createMockDnsRecord: typeof mockDnsRecord = mockDnsRecord;
export const createMockDomain: typeof mockDomain = mockDomain;
export const memoryDnsProvider: typeof memoryDns = memoryDns;
export const memoryProvider: typeof memory = memory;
export type {
  MemoryOperation,
  MemoryProvider,
  MemoryProviderCall,
  MemoryProviderOptions,
} from "./memory-provider";
export type { MemoryDnsProvider, MemoryDnsProviderOptions } from "./memory-dns-provider";
