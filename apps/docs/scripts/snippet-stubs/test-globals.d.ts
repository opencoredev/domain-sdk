// Test snippets call `expect` the way Bun, Vitest (globals), and Jest provide it.
declare global {
  const expect: typeof import("bun:test").expect;
}

export {};
