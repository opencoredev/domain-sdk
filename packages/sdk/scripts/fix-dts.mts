import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const distDir = resolve(import.meta.dir, "../dist");

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.name.endsWith(".d.ts")) files.push(full);
  }
  return files;
}

function rewriteSpecifier(file: string, specifier: string): string {
  if (specifier.endsWith(".js") || specifier.endsWith(".mjs") || specifier.endsWith(".json")) {
    return specifier;
  }
  const base = resolve(dirname(file), specifier);
  if (existsSync(`${base}.d.ts`) || existsSync(`${base}.js`)) return `${specifier}.js`;
  if (existsSync(join(base, "index.d.ts")) || existsSync(join(base, "index.js"))) {
    return `${specifier}/index.js`;
  }
  return `${specifier}.js`;
}

for (const file of walk(distDir)) {
  const source = readFileSync(file, "utf8");
  const next = source.replace(
    /((?:from|import)\s+["'])(\.\.?\/[^"']+)(["'])/g,
    (_match, prefix: string, specifier: string, suffix: string) =>
      `${prefix}${rewriteSpecifier(file, specifier)}${suffix}`,
  );
  if (next !== source) writeFileSync(file, next, "utf8");
}
