import { describe, expect, test } from "bun:test";
import type { DnsRecord, DomainIssue } from "@opencoredev/domain-sdk";

import { filterDnsRecords, issuesForRecord } from "./domain-registry-utils";

const required: DnsRecord = {
  type: "CNAME",
  name: "app.example.com",
  value: "target.example.net",
  purpose: "routing",
  required: true,
  status: "pending",
};
const optional: DnsRecord = {
  type: "CAA",
  name: "app.example.com",
  value: "0 issue example.com",
  purpose: "certificate",
  required: false,
  status: "unknown",
};

describe("DNS record helpers", () => {
  test("filters required records without mutating input", () => {
    const records = [required, optional];
    expect(filterDnsRecords(records, "required")).toEqual([required]);
    expect(filterDnsRecords(records, "all")).toEqual(records);
    expect(records).toHaveLength(2);
  });

  test("associates an issue only with its exact record", () => {
    const issue: DomainIssue = {
      code: "DNS_MISMATCH",
      message: "Value differs.",
      record: required,
      retryable: true,
    };
    expect(issuesForRecord([issue], required)).toEqual([issue]);
    expect(issuesForRecord([issue], optional)).toEqual([]);
  });
});
