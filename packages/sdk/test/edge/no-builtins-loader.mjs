// Module resolve hook that fails any import of a Node.js built-in, as edge runtimes would.
import { builtinModules } from "node:module";

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("node:") || builtins.has(specifier))
    throw new Error(`Edge runtimes cannot import ${specifier} (from ${context.parentURL}).`);
  return nextResolve(specifier, context);
}
