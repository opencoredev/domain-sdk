// Type-checks the TypeScript code blocks in content/docs/**/*.mdx, and the code
// sample on the landing page (pages/index.astro), against the SDK source, the
// way TanStack checks its doc snippets. Blog posts aren't checked: they build
// whole apps (Next.js routes, Redis, auth) across several blocks.
//
// Each ```ts or ```typescript block becomes its own module in a temp folder
// next to the stub modules in scripts/snippet-stubs (the app modules snippets
// import, such as `@/server/domains` or `./domains`), and the whole folder is
// checked with `tsc`. `@opencoredev/domain-sdk` and its subpaths resolve to
// ../../packages/sdk/src through `paths`.
//
// A block with no `import` is an excerpt (a signature, or a few lines that use
// a client set up earlier on the page) and isn't checked. Skip a complete
// block on purpose with `ignore="reason"` in its fence meta:
// ```ts ignore="Next.js middleware"
//
// Usage: bun run check:snippets

import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const docsApp = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contentRoot = join(docsApp, "content", "docs");
const stubsRoot = join(docsApp, "scripts", "snippet-stubs");
const sdkSource = resolve(docsApp, "../../packages/sdk/src");

const SUBPATHS: Record<string, string> = {
  "@opencoredev/domain-sdk": "index.ts",
  "@opencoredev/domain-sdk/vercel": "providers/vercel/index.ts",
  "@opencoredev/domain-sdk/cloudflare": "providers/cloudflare/index.ts",
  "@opencoredev/domain-sdk/railway": "providers/railway/index.ts",
  "@opencoredev/domain-sdk/render": "providers/render/index.ts",
  "@opencoredev/domain-sdk/netlify": "providers/netlify/index.ts",
  "@opencoredev/domain-sdk/bunny": "providers/bunny/index.ts",
  "@opencoredev/domain-sdk/porkbun": "providers/porkbun/index.ts",
  "@opencoredev/domain-sdk/namecheap": "providers/namecheap/index.ts",
  "@opencoredev/domain-sdk/spaceship": "providers/spaceship/index.ts",
  "@opencoredev/domain-sdk/testing": "testing/index.ts",
};

type Snippet = {
  readonly file: string;
  readonly line: number;
  readonly code: string;
  readonly title: string | undefined;
};

const isExcerpt = (code: string): boolean => !/^\s*import\s/m.test(code);

async function listMdx(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) return listMdx(path);
      return Promise.resolve(entry.name.endsWith(".mdx") ? [path] : []);
    }),
  );
  return nested.flat().sort();
}

function extractSnippets(
  file: string,
  source: string,
): { snippets: Snippet[]; skipped: number; excerpts: number } {
  const lines = source.split("\n");
  const snippets: Snippet[] = [];
  let skipped = 0;
  let excerpts = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const open = lines[index]?.match(/^(\s*)(`{3,})(\S*)(.*)$/);
    if (open === undefined || open === null) continue;
    const [, indent = "", fence = "", lang = "", meta = ""] = open;
    // Find the matching close fence even for languages we do not check.
    let end = index + 1;
    while (end < lines.length && lines[end]?.trim() !== fence) end += 1;
    if (lang === "ts" || lang === "typescript") {
      // Diff blocks are checked as their "after" version: removed lines are dropped.
      const body = lines
        .slice(index + 1, end)
        .filter((line) => !line.includes("// [!code --]"))
        .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
        .join("\n");
      const title = meta.trim().split(/\s+/)[0];
      const fileTitle = title !== undefined && /^[\w.-]+\.ts$/.test(title) ? title : undefined;
      if (/\bignore=/.test(meta)) skipped += 1;
      else if (isExcerpt(body)) excerpts += 1;
      else snippets.push({ file, line: index + 2, code: body, title: fileTitle });
    }
    index = end;
  }
  return { snippets, skipped, excerpts };
}

async function main(): Promise<void> {
  const files = await listMdx(contentRoot);
  const snippets: Snippet[] = [];
  let skipped = 0;
  let excerpts = 0;
  for (const file of files) {
    const result = extractSnippets(file, await readFile(file, "utf8"));
    snippets.push(...result.snippets);
    skipped += result.skipped;
    excerpts += result.excerpts;
  }

  // Inside node_modules so snippets resolve the docs app's packages (@types).
  const cacheRoot = join(docsApp, "node_modules", ".cache");
  await mkdir(cacheRoot, { recursive: true });
  // The landing page keeps its code sample in a template literal: `const heroExample = \`...\`;`
  const landing = join(docsApp, "pages", "index.astro");
  const landingSource = await readFile(landing, "utf8");
  for (const match of landingSource.matchAll(/const \w+Example = `([\s\S]*?)`;/g)) {
    const raw = match[1] ?? "";
    const line = landingSource.slice(0, match.index).split("\n").length + 1;
    const code = raw
      .replaceAll("\\`", "`")
      .replaceAll("\\${", "${")
      .split("\n")
      .filter((codeLine) => !codeLine.includes("// [!code --]"))
      .join("\n");
    snippets.push({ file: landing, line, code, title: undefined });
  }

  const work = await mkdtemp(join(cacheRoot, "domain-docs-snippets-"));
  try {
    for (const stub of await readdir(stubsRoot)) {
      await copyFile(join(stubsRoot, stub), join(work, stub));
    }
    const origins = new Map<string, Snippet>();
    const roots: string[] = [];
    // A block titled with a bare file name (```ts idempotency-store.ts) is written
    // under that name, so a later block can import it, unless the name repeats
    // or matches a stub.
    const stubNames = new Set(await readdir(stubsRoot));
    const titleCounts = new Map<string, number>();
    for (const snippet of snippets) {
      if (snippet.title !== undefined)
        titleCounts.set(snippet.title, (titleCounts.get(snippet.title) ?? 0) + 1);
    }
    for (const [index, snippet] of snippets.entries()) {
      const title = snippet.title;
      const named = title !== undefined && titleCounts.get(title) === 1 && !stubNames.has(title);
      const path = join(work, named ? title : `snippet-${String(index).padStart(3, "0")}.ts`);
      // `export {}` keeps every snippet a module, so top-level names never collide.
      await writeFile(path, `${snippet.code}\nexport {};\n`);
      origins.set(path, snippet);
      roots.push(path);
    }

    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
      types: ["node", "bun"],
      typeRoots: [join(docsApp, "node_modules", "@types")],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      paths: {
        ...Object.fromEntries(
          Object.entries(SUBPATHS).map(([specifier, target]) => [
            specifier,
            [join(sdkSource, target)],
          ]),
        ),
        // App aliases, so snippets can import "@/server/domains" like an app would.
        "@/server/*": [join(work, "*")],
        "@/lib/*": [join(work, "*")],
        "@/*": [join(work, "*")],
      },
    };

    // Ambient stubs (test globals) join the program; module stubs load on import.
    const ambient = [...stubNames]
      .filter((name) => name.endsWith(".d.ts"))
      .map((name) => join(work, name));
    const program = ts.createProgram([...roots, ...ambient], options);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    let failures = 0;
    for (const diagnostic of diagnostics) {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
      const source = diagnostic.file;
      const origin = source === undefined ? undefined : origins.get(source.fileName);
      if (source !== undefined && diagnostic.start !== undefined && origin !== undefined) {
        const { line, character } = source.getLineAndCharacterOfPosition(diagnostic.start);
        console.error(
          `${relative(docsApp, origin.file)}:${origin.line + line}:${character + 1} ${message}`,
        );
      } else {
        const where = source === undefined ? "" : `${relative(docsApp, source.fileName)}: `;
        console.error(`${where}${message}`);
      }
      failures += 1;
    }

    const summary = `${snippets.length} snippets checked in ${files.length} pages and the landing page, ${excerpts} excerpts without imports left out, ${skipped} skipped with ignore=`;
    if (failures > 0) {
      console.error(`\n${failures} problem(s). ${summary}.`);
      process.exitCode = 1;
    } else {
      console.log(`OK: ${summary}.`);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

await main();
