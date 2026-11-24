#!/usr/bin/env node
import { runCli } from "./cli/run";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  signal: controller.signal,
});
