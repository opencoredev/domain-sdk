import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockFile = resolve(appDirectory, ".next/dev/lock");

function lockHolders(): number[] {
  const result = spawnSync("lsof", ["-t", lockFile], { encoding: "utf8" });
  return result.stdout
    .trim()
    .split("\n")
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

for (const pid of lockHolders()) {
  const cwd = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    encoding: "utf8",
  }).stdout
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1);
  const command = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  }).stdout;

  if (cwd !== appDirectory || !command.includes("next-server")) {
    throw new Error(`Refusing to stop unexpected process ${pid} holding ${lockFile}.`);
  }

  console.log(`Stopping previous Next.js dev server (${pid})...`);
  process.kill(pid, "SIGTERM");
}

for (let attempt = 0; attempt < 20 && lockHolders().length > 0; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

if (lockHolders().length > 0) {
  throw new Error("The previous Next.js dev server did not stop within two seconds.");
}
