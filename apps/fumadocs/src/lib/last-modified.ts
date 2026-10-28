import { execFileSync } from "node:child_process";

function git(args: readonly string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

let shallowBoundary: ReadonlySet<string> | undefined;

// In a shallow clone (Vercel clones with limited depth), every file last changed before the
// clone boundary reports the boundary commit, which is newer than the real change. Boundary
// commits are the clone's parentless commits.
function getShallowBoundary(): ReadonlySet<string> {
  if (shallowBoundary) return shallowBoundary;

  const isShallow = git(["rev-parse", "--is-shallow-repository"]) === "true";
  const roots = isShallow ? git(["rev-list", "--max-parents=0", "HEAD"]) : undefined;
  shallowBoundary = new Set(roots ? roots.split("\n").filter(Boolean) : []);
  return shallowBoundary;
}

/**
 * Date of the last commit that touched any of `paths`. Returns undefined when git can't
 * tell: no repository, an untracked path, or a commit on a shallow-clone boundary.
 */
export function gitLastModified(paths: readonly string[]): Date | undefined {
  const output = git(["log", "-1", "--format=%H %cI", "--", ...paths]);
  if (!output) return undefined;

  const [hash, committedAt] = output.split(" ");
  if (!hash || !committedAt || getShallowBoundary().has(hash)) return undefined;

  const date = new Date(committedAt);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
