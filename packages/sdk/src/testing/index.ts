import { createMockDnsRecord as mockDnsRecord, createMockDomain as mockDomain } from "./factories";
import { memoryDnsProvider as memoryDns } from "./memory-dns-provider";
import {
  createFailingProvider as failingProvider,
  memoryProvider as memory,
} from "./memory-provider";

export const createFailingProvider: typeof failingProvider = (...arguments_) =>
  failingProvider(...arguments_);
export const createMockDnsRecord: typeof mockDnsRecord = (...arguments_) =>
  mockDnsRecord(...arguments_);
export const createMockDomain: typeof mockDomain = (...arguments_) => mockDomain(...arguments_);
export const memoryDnsProvider: typeof memoryDns = (...arguments_) => memoryDns(...arguments_);
export const memoryProvider: typeof memory = (...arguments_) => memory(...arguments_);
export type {
  MemoryOperation,
  MemoryProvider,
  MemoryProviderCall,
  MemoryProviderOptions,
} from "./memory-provider";
export type { MemoryDnsProvider, MemoryDnsProviderOptions } from "./memory-dns-provider";
