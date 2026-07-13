"use client";

import * as React from "react";
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Copy01Icon,
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

const records = [
  {
    type: "CNAME",
    name: "app.customer-example.com",
    value: "cname.domain-platform.example",
    status: "Pending",
    required: true,
  },
  {
    type: "TXT",
    name: "_domain-verify.app.customer-example.com",
    value: "domain-verification=Jb7fE4qM9K2pL8nR6vX1aC3dH5sT0wYz",
    status: "Valid",
    required: true,
  },
  {
    type: "CAA",
    name: "app.customer-example.com",
    value: '0 issue "letsencrypt.org"',
    status: "Invalid",
    required: false,
  },
] as const;

const statusMeta = {
  Valid: {
    icon: CheckmarkCircle02Icon,
    variant: "outline",
    className:
      "border-transparent bg-primary/10 text-primary bg-[var(--dns-success)] text-[var(--dns-success-foreground)]",
  },
  Pending: {
    icon: TimeQuarter02Icon,
    variant: "outline",
    className:
      "border-transparent bg-secondary text-secondary-foreground bg-[var(--dns-warning)] text-[var(--dns-warning-foreground)]",
  },
  Invalid: { icon: Alert02Icon, variant: "destructive", className: "" },
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

type PreviewRecord = (typeof records)[number];

function Status({ status }: { status: (typeof records)[number]["status"] }) {
  const meta = statusMeta[status];

  return (
    <Badge variant={meta.variant} className={meta.className}>
      <HugeiconsIcon icon={meta.icon} data-icon="inline-start" aria-hidden="true" />
      {status}
    </Badge>
  );
}

function PreviewCopyableField({
  record,
  field,
  copied,
  mobile = false,
  onCopy,
}: {
  record: PreviewRecord;
  field: "name" | "value";
  copied: boolean;
  mobile?: boolean;
  onCopy(content: string, key: string): void | Promise<void>;
}) {
  const key = `${field}:${record.type}:${record[field]}`;

  return (
    <Button
      type="button"
      variant="ghost"
      className={copyableFieldClassName[mobile ? "mobile" : "desktop"]}
      onClick={() => void onCopy(record[field], key)}
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

export function DnsRecordsPreview() {
  const [filter, setFilter] = React.useState<"required" | "all">("required");
  const [copied, setCopied] = React.useState<string>();
  const [announcement, setAnnouncement] = React.useState("");
  const timerRef = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  const visibleRecords =
    filter === "required" ? records.filter((record) => record.required) : records;

  React.useEffect(() => () => clearTimeout(timerRef.current), []);

  async function copy(content: string, key: string) {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      setAnnouncement("Could not copy. Check clipboard permissions, then try again.");
      return;
    }
    setCopied(key);
    setAnnouncement("Copied to the clipboard.");
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(undefined), 1800);
  }

  async function copyAll() {
    await copy(
      visibleRecords.map((record) => `${record.type}\t${record.name}\t${record.value}`).join("\n"),
      "all",
    );
  }

  return (
    <section className="dns-records-preview my-8 min-w-0 text-foreground" style={dnsStatusStyle}>
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-sm font-semibold">DNS records</h2>
          <p className="text-sm text-muted-foreground">
            Click any name or value to copy it, then add the records at your DNS provider.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <NativeSelect
            value={filter}
            onChange={(event) => setFilter(event.target.value as "required" | "all")}
            aria-label="Filter DNS records"
            size="sm"
          >
            <NativeSelectOption value="required">Required</NativeSelectOption>
            <NativeSelectOption value="all">All records</NativeSelectOption>
          </NativeSelect>
          <Button type="button" variant="outline" size="sm" onClick={() => void copyAll()}>
            <HugeiconsIcon
              icon={copied === "all" ? CheckmarkCircle02Icon : Copy01Icon}
              data-icon="inline-start"
              aria-hidden="true"
            />
            {copied === "all" ? "Copied" : "Copy all"}
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
              {visibleRecords.map((record) => (
                <TableRow key={`${record.type}:${record.name}`}>
                  <TableCell className="px-4 py-3">
                    <span className="text-xs font-semibold">{record.type}</span>
                  </TableCell>
                  <TableCell className="p-0">
                    <PreviewCopyableField
                      record={record}
                      field="name"
                      copied={copied === `name:${record.type}:${record.name}`}
                      onCopy={copy}
                    />
                  </TableCell>
                  <TableCell className="p-0">
                    <PreviewCopyableField
                      record={record}
                      field="value"
                      copied={copied === `value:${record.type}:${record.value}`}
                      onCopy={copy}
                    />
                  </TableCell>
                  <TableCell className="px-4 py-3">
                    <Status status={record.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="divide-y md:hidden">
          {visibleRecords.map((record) => (
            <article
              key={`${record.type}:${record.name}`}
              className="flex flex-col gap-3 px-4 py-4"
            >
              <header className="flex items-center justify-between gap-3">
                <span className="text-xs font-semibold">{record.type}</span>
                <Status status={record.status} />
              </header>
              <dl className="grid gap-2">
                <div className="grid gap-0.5">
                  <dt className="px-2 text-xs text-muted-foreground">Name</dt>
                  <dd>
                    <PreviewCopyableField
                      record={record}
                      field="name"
                      copied={copied === `name:${record.type}:${record.name}`}
                      mobile
                      onCopy={copy}
                    />
                  </dd>
                </div>
                <div className="grid gap-0.5">
                  <dt className="px-2 text-xs text-muted-foreground">Value</dt>
                  <dd>
                    <PreviewCopyableField
                      record={record}
                      field="value"
                      copied={copied === `value:${record.type}:${record.value}`}
                      mobile
                      onCopy={copy}
                    />
                  </dd>
                </div>
              </dl>
            </article>
          ))}
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
