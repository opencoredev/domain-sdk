import type { DnsRecord } from "./types";

export function deduplicateRecords(records: readonly DnsRecord[]): DnsRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = `${record.type}\0${record.name.toLowerCase()}\0${record.value}\0${record.purpose}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function fullRecordName(name: string, hostname: string): string {
  const clean = name.trim().replace(/\.$/, "").toLowerCase();
  if (!clean || clean === "@") return hostname;
  if (clean === hostname || clean.endsWith(`.${hostname}`) || clean.includes(".")) return clean;
  return `${clean}.${hostname}`;
}
