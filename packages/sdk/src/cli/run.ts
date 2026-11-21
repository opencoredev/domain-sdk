import { createDomainClient } from "../core/client";
import { DomainSdkError, normalizeUnknownError } from "../core/errors";
import type { Fetch } from "../core/http";
import type { DomainClient } from "../core/provider";
import { deduplicateRecords } from "../core/records";
import type { Domain, DomainPage } from "../core/types";
import { CLI_PROVIDERS, type CliEnv, type CliProviderFactory } from "./providers";

export interface CliIo {
  env: CliEnv;
  stdout(text: string): void;
  stderr(text: string): void;
  /** Cancels the running command, for example on Ctrl-C. */
  signal?: AbortSignal;
  /** Passed to every provider adapter. Defaults to the global `fetch`. */
  fetch?: Fetch;
  /** Extra or replacement providers, keyed by `--provider` name. */
  providers?: Readonly<Record<string, CliProviderFactory>>;
}

/** Exit codes: 0 success, 1 the operation failed, 2 the command line was invalid. */
export type CliExitCode = 0 | 1 | 2;

const COMMANDS = ["add", "get", "list", "verify", "remove", "wait"] as const;
type Command = (typeof COMMANDS)[number];

const isCommand = (value: string | undefined): value is Command =>
  COMMANDS.some((command) => command === value);

const VALUE_FLAGS = ["provider", "limit", "cursor", "timeout-ms", "interval-ms"] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];
const isValueFlag = (name: string): name is ValueFlag => VALUE_FLAGS.some((flag) => flag === name);

interface ParsedArgs {
  command?: Command;
  positionals: string[];
  values: Partial<Record<ValueFlag, string>>;
  json: boolean;
  help: boolean;
}

class UsageError extends Error {}

const HELP = `Usage: domain-sdk <command> [hostname] [options]

Commands:
  add <hostname>      Attach a hostname and print the DNS records to configure
  get <hostname>      Show a hostname's status and records
  list                List hostnames (--limit 1-100, --cursor <next cursor>)
  verify <hostname>   Ask the provider to verify a hostname now
  remove <hostname>   Detach a hostname
  wait <hostname>     Poll until the hostname is active (--timeout-ms, --interval-ms)

Options:
  --provider <name>   ${Object.keys(CLI_PROVIDERS).join(", ")} (or DOMAIN_SDK_PROVIDER)
  --json              Print machine-readable JSON
  -h, --help          Show this help

Credentials come from environment variables, for example VERCEL_TOKEN and VERCEL_PROJECT_ID.
`;

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { positionals: [], values: {}, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "-h" || argument === "--help") {
      parsed.help = true;
      continue;
    }
    if (argument === "--json") {
      parsed.json = true;
      continue;
    }
    if (argument.startsWith("--")) {
      const [name = "", inline] = argument.slice(2).split(/=(.*)/s, 2);
      if (!isValueFlag(name)) throw new UsageError(`Unknown option --${name}.`);
      const flagValue = inline ?? argv[++index];
      if (
        flagValue === undefined ||
        flagValue === "" ||
        (inline === undefined && flagValue.startsWith("--"))
      )
        throw new UsageError(`--${name} needs a value.`);
      parsed.values[name] = flagValue;
      continue;
    }
    if (argument.startsWith("-")) throw new UsageError(`Unknown option ${argument}.`);
    if (parsed.command === undefined && parsed.positionals.length === 0) {
      if (!isCommand(argument)) throw new UsageError(`Unknown command ${argument}.`);
      parsed.command = argument;
      continue;
    }
    parsed.positionals.push(argument);
  }
  return parsed;
}

function integerFlag(
  values: ParsedArgs["values"],
  name: ValueFlag,
  bounds?: { min?: number; max?: number },
): number | undefined {
  const raw = values[name];
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new UsageError(`--${name} must be a whole number.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new UsageError(`--${name} is out of range.`);
  if (bounds?.min !== undefined && value < bounds.min)
    throw new UsageError(
      bounds.max !== undefined
        ? `--${name} must be between ${bounds.min} and ${bounds.max}.`
        : `--${name} must be at least ${bounds.min}.`,
    );
  if (bounds?.max !== undefined && value > bounds.max)
    throw new UsageError(`--${name} must be between ${bounds.min ?? 0} and ${bounds.max}.`);
  return value;
}

function createClient(args: ParsedArgs, io: CliIo): DomainClient {
  const providers = { ...CLI_PROVIDERS, ...io.providers };
  const name = args.values.provider ?? io.env.DOMAIN_SDK_PROVIDER;
  if (!name) throw new UsageError("Pass --provider or set DOMAIN_SDK_PROVIDER.");
  const factory = Object.hasOwn(providers, name) ? providers[name] : undefined;
  if (!factory)
    throw new UsageError(
      `Unknown provider ${name}. Choose one of: ${Object.keys(providers).join(", ")}.`,
    );
  const missing = factory.required.filter((variable) => !io.env[variable]);
  if (missing.length)
    throw new UsageError(
      `The ${name} provider needs these environment variables: ${missing.join(", ")}.`,
    );
  return createDomainClient({ provider: factory.create(io.env, io.fetch) });
}

function formatDomain(domain: Domain): string {
  const lines = [
    `${domain.hostname}  ${domain.status}`,
    `  provider:      ${domain.provider}`,
    `  verification:  ${domain.verification.status}`,
    `  certificate:   ${domain.certificate.status}`,
  ];
  const records = deduplicateRecords([...domain.records, ...domain.verification.records]);
  if (records.length) {
    lines.push("", "  DNS records:");
    for (const record of records)
      lines.push(
        `    ${record.type.padEnd(6)} ${record.name}  ${record.value}  (${record.required ? "required" : "optional"}, ${record.status})`,
      );
  }
  if (domain.issues.length) {
    lines.push("", "  Issues:");
    for (const issue of domain.issues) lines.push(`    ${issue.code}: ${issue.message}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatPage(page: DomainPage): string {
  if (!page.domains.length) return "No domains.\n";
  const width = Math.max(...page.domains.map((domain) => domain.hostname.length));
  const lines = page.domains.map((domain) => `${domain.hostname.padEnd(width)}  ${domain.status}`);
  if (page.nextCursor) lines.push("", `More results: --cursor ${page.nextCursor}`);
  return `${lines.join("\n")}\n`;
}

const toJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

async function execute(args: ParsedArgs, client: DomainClient, io: CliIo): Promise<string> {
  const options = { signal: io.signal };
  const output = (domain: Domain) => (args.json ? toJson(domain) : formatDomain(domain));
  const hostname = () => {
    const [value, extra] = args.positionals;
    if (!value) throw new UsageError(`${args.command} needs a hostname.`);
    if (extra !== undefined) throw new UsageError(`Unexpected argument ${extra}.`);
    return value;
  };
  switch (args.command) {
    case "add":
      return output(await client.add(hostname(), options));
    case "get":
      return output(await client.get(hostname(), options));
    case "verify":
      return output(await client.verify(hostname(), options));
    case "remove": {
      const target = hostname();
      await client.remove(target, options);
      return args.json ? toJson({ hostname: target, removed: true }) : `Removed ${target}.\n`;
    }
    case "list": {
      if (args.positionals.length)
        throw new UsageError(`Unexpected argument ${args.positionals[0]}.`);
      const page = await client.list({
        limit: integerFlag(args.values, "limit", { min: 1, max: 100 }),
        cursor: args.values.cursor,
        signal: io.signal,
      });
      return args.json ? toJson(page) : formatPage(page);
    }
    case "wait": {
      const target = hostname();
      let last: string | undefined;
      const domain = await client.waitUntilActive(target, {
        timeoutMs: integerFlag(args.values, "timeout-ms", { min: 0 }),
        intervalMs: integerFlag(args.values, "interval-ms", { min: 250 }),
        signal: io.signal,
        onStatus: (current) => {
          if (!args.json && current.status !== last) io.stderr(`${target}: ${current.status}\n`);
          last = current.status;
        },
      });
      return output(domain);
    }
    case undefined:
      throw new UsageError("Pass a command.");
    default: {
      const exhaustive: never = args.command;
      throw new UsageError(`Unknown command ${String(exhaustive)}.`);
    }
  }
}

function reportError(error: DomainSdkError, json: boolean, io: CliIo) {
  if (json)
    io.stderr(
      toJson({
        error: {
          code: error.code,
          message: error.message,
          provider: error.provider,
          retryable: error.retryable,
          details: error.details,
        },
      }),
    );
  else io.stderr(`Error ${error.code}: ${error.message}\n`);
}

/** Run the `domain-sdk` command line and return its exit code. Never throws. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<CliExitCode> {
  let args: ParsedArgs | undefined;
  try {
    args = parseArgs(argv);
    if (args.help) {
      io.stdout(HELP);
      return 0;
    }
    if (!args.command) {
      if (args.json) throw new UsageError("Pass a command.");
      io.stderr(HELP);
      return 2;
    }
    const client = createClient(args, io);
    io.stdout(await execute(args, client, io));
    return 0;
  } catch (error) {
    const jsonRequested = args?.json === true || argv.includes("--json");
    if (error instanceof UsageError) {
      if (jsonRequested) {
        io.stderr(toJson({ error: { code: "USAGE", message: error.message } }));
      } else {
        io.stderr(`${error.message}\nRun domain-sdk --help for usage.\n`);
      }
      return 2;
    }
    reportError(normalizeUnknownError(error), jsonRequested, io);
    return 1;
  }
}
