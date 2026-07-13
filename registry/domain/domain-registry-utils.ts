import type { DnsRecord, DomainIssue } from "@opencoredev/domain-sdk";

export type DnsRecordFilter = "required" | "all";

export function filterDnsRecords(
  records: readonly DnsRecord[],
  filter: DnsRecordFilter,
): DnsRecord[] {
  return filter === "required" ? records.filter((record) => record.required) : [...records];
}

export function issuesForRecord(issues: readonly DomainIssue[], record: DnsRecord): DomainIssue[] {
  return issues.filter(
    (issue) =>
      issue.record?.type === record.type &&
      issue.record.name === record.name &&
      issue.record.value === record.value &&
      issue.record.purpose === record.purpose,
  );
}
