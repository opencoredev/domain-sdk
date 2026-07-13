"use client";

import * as React from "react";
import type { DnsRecord, DomainIssue } from "@opencoredev/domain-sdk";
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Copy01Icon,
  HelpCircleIcon,
  TimeQuarter02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  filterDnsRecords,
  issuesForRecord,
  type DnsRecordFilter,
} from "@/components/domain/domain-registry-utils";

export type DnsRecordCopyField = "name" | "value";

export interface DnsRecordsTableProps {
  records: readonly DnsRecord[];
  issues?: readonly DomainIssue[];
  defaultFilter?: DnsRecordFilter;
  onCopy?(content: string, record: DnsRecord, field: DnsRecordCopyField): void | Promise<void>;
}

const statusMeta = {
  valid: {
    label: "Valid",
    icon: CheckmarkCircle02Icon,
    variant: "outline",
    className:
      "border-transparent bg-primary/10 text-primary bg-[var(--dns-success)] text-[var(--dns-success-foreground)]",
  },
  pending: {
    label: "Pending",
    icon: TimeQuarter02Icon,
    variant: "outline",
    className:
      "border-transparent bg-secondary text-secondary-foreground bg-[var(--dns-warning)] text-[var(--dns-warning-foreground)]",
  },
  invalid: {
    label: "Invalid",
    icon: Alert02Icon,
    variant: "destructive",
    className: "",
  },
  unknown: {
    label: "Unknown",
    icon: HelpCircleIcon,
    variant: "outline",
    className: "",
  },
} as const;

const dnsStatusStyle = {
  "--dns-success": "light-dark(oklch(0.94 0.06 150), oklch(0.28 0.07 150))",
  "--dns-success-foreground": "light-dark(oklch(0.34 0.12 150), oklch(0.84 0.13 150))",
  "--dns-warning": "light-dark(oklch(0.95 0.07 85), oklch(0.29 0.07 75))",
  "--dns-warning-foreground": "light-dark(oklch(0.4 0.11 70), oklch(0.86 0.13 85))",
} as React.CSSProperties;

const copyableFieldClassName = {
  desktop:
    "h-auto min-h-12 w-full touch-manipulation justify-between rounded-none px-4 py-3 text-left whitespace-normal",
  mobile:
    "h-auto min-h-10 w-full touch-manipulation justify-between rounded-md px-2 py-2 text-left whitespace-normal",
} as const;

const copyFeedbackClassName = {
  copied:
    "inline-flex shrink-0 items-center gap-1 text-xs font-medium text-foreground opacity-100 transition-opacity duration-150 motion-reduce:transition-none",
  idle: "inline-flex shrink-0 items-center gap-1 text-xs font-medium text-foreground opacity-60 transition-opacity duration-150 motion-reduce:transition-none md:opacity-0 md:group-hover/button:opacity-100 md:group-focus-visible/button:opacity-100",
} as const;

function RecordStatus({ status }: { status: DnsRecord["status"] }) {
  const meta = statusMeta[status];

  return (
    <Badge variant={meta.variant} className={meta.className}>
      <HugeiconsIcon icon={meta.icon} data-icon="inline-start" aria-hidden="true" />
      {meta.label}
    </Badge>
  );
}

function CopyableRecordField({
  record,
  field,
  copied,
  mobile = false,
  onCopy,
}: {
  record: DnsRecord;
  field: DnsRecordCopyField;
  copied: boolean;
  mobile?: boolean;
  onCopy(record: DnsRecord, field: DnsRecordCopyField): void | Promise<void>;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      className={copyableFieldClassName[mobile ? "mobile" : "desktop"]}
      onClick={() => void onCopy(record, field)}
      aria-label={`Copy ${field} for ${record.name}`}
      title={`Copy ${field === "name" ? "Name" : "Value"}`}
    >
      <code className="block min-w-0 break-all text-xs" translate="no">
        {record[field]}
      </code>
      <span className={copyFeedbackClassName[copied ? "copied" : "idle"]} aria-hidden="true">
        <HugeiconsIcon
          icon={copied ? CheckmarkCircle02Icon : Copy01Icon}
          data-icon="inline-end"
          aria-hidden="true"
        />
        {copied ? "Copied" : "Copy"}
      </span>
    </Button>
  );
}

export function DnsRecordsTable({
  records,
  issues = [],
  defaultFilter = "required",
  onCopy,
}: DnsRecordsTableProps) {
  const headingId = React.useId();
  const [filter, setFilter] = React.useState<DnsRecordFilter>(defaultFilter);
  const [copiedField, setCopiedField] = React.useState<string>();
  const [announcement, setAnnouncement] = React.useState("");
  const timerRef = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  const visibleRecords = filterDnsRecords(records, filter);
  const hasOptionalRecords = records.some((record) => !record.required);

  React.useEffect(() => () => clearTimeout(timerRef.current), []);

  function showCopied(key: string) {
    setCopiedField(key);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopiedField(undefined), 1800);
  }

  function fieldKey(record: DnsRecord, field: DnsRecordCopyField) {
    return `${field}:${record.type}:${record.name}:${record.value}`;
  }

  async function copyField(record: DnsRecord, field: DnsRecordCopyField) {
    const content = record[field];

    try {
      if (onCopy) await onCopy(content, record, field);
      else await navigator.clipboard.writeText(content);
    } catch {
      setAnnouncement(
        `Could not copy the ${field} for ${record.name}. Check clipboard permissions, then try again.`,
      );
      return;
    }

    showCopied(fieldKey(record, field));
    setAnnouncement(`Copied the ${field} for ${record.name}.`);
  }

  async function copyAll() {
    const combined = visibleRecords
      .map((record) => `${record.type}\t${record.name}\t${record.value}`)
      .join("\n");

    try {
      await navigator.clipboard.writeText(combined);
      showCopied("all");
      setAnnouncement(`Copied ${visibleRecords.length} DNS records.`);
    } catch {
      setAnnouncement(
        "Could not copy the DNS records. Check clipboard permissions, then try again.",
      );
    }
  }

  return (
    <section aria-labelledby={headingId} className="min-w-0 text-foreground" style={dnsStatusStyle}>
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={headingId} className="text-sm font-semibold">
            DNS records
          </h2>
          <p className="text-sm text-muted-foreground">
            Click any name or value to copy it, then add the records at your DNS provider.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasOptionalRecords ? (
            <NativeSelect
              value={filter}
              onChange={(event) => setFilter(event.target.value as DnsRecordFilter)}
              aria-label="Filter DNS records"
              size="sm"
            >
              <NativeSelectOption value="required">Required</NativeSelectOption>
              <NativeSelectOption value="all">All records</NativeSelectOption>
            </NativeSelect>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={visibleRecords.length === 0}
            onClick={() => void copyAll()}
          >
            <HugeiconsIcon
              icon={copiedField === "all" ? CheckmarkCircle02Icon : Copy01Icon}
              data-icon="inline-start"
              aria-hidden="true"
            />
            {copiedField === "all" ? "Copied" : "Copy all"}
          </Button>
        </div>
      </header>

      <div className="overflow-hidden rounded-lg border bg-background">
        <div className="hidden md:block">
          <Table>
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead className="h-9 w-24 px-4 text-xs text-muted-foreground">Type</TableHead>
                <TableHead className="h-9 w-[30%] px-4 text-xs text-muted-foreground">
                  Name
                </TableHead>
                <TableHead className="h-9 px-4 text-xs text-muted-foreground">Value</TableHead>
                <TableHead className="h-9 w-24 px-4 text-xs text-muted-foreground">
                  Status
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRecords.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className="h-20 px-4 text-center text-sm text-muted-foreground"
                  >
                    No DNS records in this view.
                  </TableCell>
                </TableRow>
              ) : null}
              {visibleRecords.map((record, index) => {
                const key = `${record.type}:${record.name}:${record.value}`;
                const recordIssues = issuesForRecord(issues, record);

                return (
                  <React.Fragment key={`${key}:${index}`}>
                    <TableRow>
                      <TableCell className="px-4 py-3">
                        <span className="text-xs font-semibold">{record.type}</span>
                      </TableCell>
                      <TableCell className="p-0">
                        <CopyableRecordField
                          record={record}
                          field="name"
                          copied={copiedField === fieldKey(record, "name")}
                          onCopy={copyField}
                        />
                      </TableCell>
                      <TableCell className="p-0">
                        <CopyableRecordField
                          record={record}
                          field="value"
                          copied={copiedField === fieldKey(record, "value")}
                          onCopy={copyField}
                        />
                      </TableCell>
                      <TableCell className="px-4 py-3">
                        <RecordStatus status={record.status} />
                      </TableCell>
                    </TableRow>
                    {recordIssues.map((issue) => (
                      <TableRow
                        key={`${key}:${issue.code}`}
                        className="bg-destructive/5 hover:bg-destructive/5"
                      >
                        <TableCell
                          colSpan={4}
                          className="whitespace-normal px-4 py-2.5 text-xs text-destructive"
                        >
                          {issue.message} Update this record, then refresh the domain.
                        </TableCell>
                      </TableRow>
                    ))}
                  </React.Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>

        <div className="divide-y md:hidden">
          {visibleRecords.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No DNS records in this view.
            </p>
          ) : null}
          {visibleRecords.map((record) => {
            const key = `${record.type}:${record.name}:${record.value}`;
            const recordIssues = issuesForRecord(issues, record);

            return (
              <article key={key} className="flex flex-col gap-3 px-4 py-4">
                <header className="flex items-center justify-between gap-3">
                  <span className="text-xs font-semibold">{record.type}</span>
                  <RecordStatus status={record.status} />
                </header>
                <dl className="grid gap-2">
                  <div className="grid gap-0.5">
                    <dt className="px-2 text-xs text-muted-foreground">Name</dt>
                    <dd>
                      <CopyableRecordField
                        record={record}
                        field="name"
                        copied={copiedField === fieldKey(record, "name")}
                        mobile
                        onCopy={copyField}
                      />
                    </dd>
                  </div>
                  <div className="grid gap-0.5">
                    <dt className="px-2 text-xs text-muted-foreground">Value</dt>
                    <dd>
                      <CopyableRecordField
                        record={record}
                        field="value"
                        copied={copiedField === fieldKey(record, "value")}
                        mobile
                        onCopy={copyField}
                      />
                    </dd>
                  </div>
                </dl>
                {recordIssues.map((issue) => (
                  <p key={issue.code} className="text-xs text-destructive">
                    {issue.message} Update this record, then refresh the domain.
                  </p>
                ))}
              </article>
            );
          })}
        </div>

        <p className="border-t bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
          DNS changes can take time to propagate. Keep the names and values exactly as shown.
        </p>
      </div>

      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </section>
  );
}
