import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dist = join(import.meta.dir, "..", "dist");

function builtFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return builtFiles(path);
    return entry.name.endsWith(".js") ? [path] : [];
  });
}

describe("edge runtime compatibility of the built package", () => {
  test("every import in dist is a relative chunk, never a Node.js built-in", () => {
    const files = builtFiles(dist);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const specifiers = [...source.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(
        (match) => match[1],
      );
      for (const specifier of specifiers)
        expect({ file, specifier }).toEqual({
          file,
          specifier: expect.stringMatching(/^\.\.?\//),
        });
      expect({ file, require: /\brequire\(|createRequire|__require/.test(source) }).toEqual({
        file,
        require: false,
      });
    }
  });

  test("loads and runs with Node.js built-ins blocked", () => {
    const edge = join(import.meta.dir, "edge");
    const result = Bun.spawnSync(
      ["node", "--import", join(edge, "register.mjs"), join(edge, "smoke.mjs")],
      { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe", timeout: 30_000 },
    );
    const stderr = result.stderr.toString();
    expect({ exitCode: result.exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    const output = JSON.parse(result.stdout.toString().trim()) as {
      loaded: string[];
      status: string;
      records: number;
    };
    expect(output.loaded).toHaveLength(11);
    expect(output.status).toBe("active");
    expect(output.records).toBeGreaterThan(0);
  });
});
