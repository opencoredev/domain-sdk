import { isIP } from "node:net";
import { getDomainWithoutSuffix, getPublicSuffix } from "tldts";

import {
  absoluteRecordName,
  canonicalRecordValue,
  relativeRecordName,
  type DnsProvider,
  type DnsProviderContext,
  type ZoneRecord,
} from "../../core/dns";
import { DomainSdkError, parseRetryAfter, type DomainSdkErrorCode } from "../../core/errors";
import { requireString, type Fetch } from "../../core/http";
import { MAX_XML_BYTES, parseXml, type XmlElement } from "./xml";

export interface NamecheapOptions {
  apiUser: string;
  apiKey: string;
  userName?: string;
  clientIp: string;
  sandbox?: boolean;
  ttl?: number;
  fetch?: Fetch;
}

interface Host {
  id?: string;
  name: string;
  type: string;
  address: string;
  mxPref?: string;
  ttl: string;
}

interface HostSnapshot {
  hosts: Host[];
  emailType?: string;
}

function malformed(): never {
  throw new DomainSdkError("REQUEST_FAILED", "Namecheap returned an invalid DNS response.", {
    provider: "namecheap",
  });
}

async function readXmlResponse(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  // Reject invalid UTF-8 instead of silently replacing bytes in record values.
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const decode = (value?: Uint8Array) => {
    try {
      return value ? decoder.decode(value, { stream: true }) : decoder.decode();
    } catch {
      return malformed();
    }
  };
  const chunks: string[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_XML_BYTES) {
        void reader.cancel().catch(() => {});
        malformed();
      }
      chunks.push(decode(value));
    }
    chunks.push(decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

function result(root: XmlElement, name: string): XmlElement {
  return (
    root.children
      .find((child) => child.name === "CommandResponse")
      ?.children.find((child) => child.name === name) ?? malformed()
  );
}

function zoneRecord(host: Host, zone: string): ZoneRecord {
  return {
    id: host.id,
    type: host.type,
    name: absoluteRecordName(host.name, zone),
    value: host.type === "CAA" ? canonicalRecordValue("CAA", host.address) : host.address,
    ttl: Number(host.ttl),
    priority: host.mxPref === undefined ? undefined : Number(host.mxPref),
    editable: true,
  };
}

function hostKey(host: Host, zone: string): string {
  const record = zoneRecord(host, zone);
  return JSON.stringify([
    record.type,
    record.name,
    ["A", "AAAA", "ALIAS", "CAA", "CNAME", "MX", "NS"].includes(record.type)
      ? canonicalRecordValue(record.type, record.value)
      : record.value,
    record.ttl,
    host.type === "MX" || host.type === "MXE" ? (record.priority ?? 10) : undefined,
  ]);
}

export function namecheap(options: NamecheapOptions): DnsProvider {
  const apiUser = requireString(options.apiUser, "apiUser", "namecheap");
  const apiKey = requireString(options.apiKey, "apiKey", "namecheap");
  const userName = requireString(options.userName ?? apiUser, "userName", "namecheap");
  const clientIp = requireString(options.clientIp, "clientIp", "namecheap");
  const ttl = options.ttl ?? 1800;
  if (isIP(clientIp) !== 4 || !Number.isInteger(ttl) || ttl < 60 || ttl > 60000)
    throw new DomainSdkError(
      "INVALID_CONFIGURATION",
      "Namecheap requires an IPv4 clientIp and a TTL between 60 and 60000 seconds.",
      { provider: "namecheap" },
    );
  const doFetch = options.fetch ?? globalThis.fetch;
  if (!doFetch)
    throw new DomainSdkError("INVALID_CONFIGURATION", "Namecheap requires fetch.", {
      provider: "namecheap",
    });
  const endpoint = options.sandbox
    ? "https://api.sandbox.namecheap.com/xml.response"
    : "https://api.namecheap.com/xml.response";
  const queues = new Map<string, Promise<void>>();

  const request = async (
    zone: string,
    command: string,
    context: DnsProviderContext,
    parameters: Record<string, string> = {},
  ): Promise<XmlElement> => {
    const sld = getDomainWithoutSuffix(zone);
    const tld = getPublicSuffix(zone);
    if (!sld || !tld || `${sld}.${tld}` !== zone)
      throw new DomainSdkError("INVALID_CONFIGURATION", "Namecheap requires a domain apex.", {
        provider: "namecheap",
      });
    const body = new URLSearchParams({
      ApiUser: apiUser,
      ApiKey: apiKey,
      UserName: userName,
      ClientIp: clientIp,
      Command: `namecheap.domains.dns.${command}`,
      SLD: sld,
      TLD: tld,
      ...parameters,
    });
    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: "POST",
        headers: { accept: "application/xml", "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: context.signal,
      });
    } catch {
      throw new DomainSdkError(
        context.signal?.aborted ? "ABORTED" : "PROVIDER_UNAVAILABLE",
        context.signal?.aborted
          ? "The Namecheap request was cancelled."
          : "Could not reach Namecheap.",
        { provider: "namecheap", retryable: !context.signal?.aborted },
      );
    }
    const failure = (code: DomainSdkErrorCode, message: string, providerCode?: string): never => {
      throw new DomainSdkError(code, message, {
        provider: "namecheap",
        statusCode: response.status,
        retryable: code === "RATE_LIMITED" || code === "PROVIDER_UNAVAILABLE",
        retryAfter: parseRetryAfter(response.headers.get("retry-after")),
        details: providerCode ? { providerCode } : undefined,
      });
    };
    if (response.status === 405 || response.status === 429)
      failure("RATE_LIMITED", "Namecheap rate limited the request.");
    if (response.status >= 500) failure("PROVIDER_UNAVAILABLE", "Namecheap is unavailable.");
    if (response.status === 401)
      failure("AUTHENTICATION_FAILED", "Namecheap rejected the API credentials.");
    if (response.status === 403) failure("PERMISSION_DENIED", "Namecheap denied access.");
    if (response.status === 404)
      failure("DOMAIN_NOT_FOUND", "Namecheap could not find the domain.");
    if (!response.ok) failure("REQUEST_FAILED", "Namecheap rejected the request.");
    let text: string;
    try {
      text = await readXmlResponse(response);
    } catch (error) {
      if (error instanceof DomainSdkError) throw error;
      throw new DomainSdkError(
        context.signal?.aborted ? "ABORTED" : "PROVIDER_UNAVAILABLE",
        context.signal?.aborted
          ? "The Namecheap request was cancelled."
          : "Could not read the Namecheap response.",
        { provider: "namecheap", retryable: !context.signal?.aborted },
      );
    }
    const root = parseXml(text);
    if (root.name !== "ApiResponse") malformed();
    const errors = root.children.find((child) => child.name === "Errors")?.children ?? [];
    if (root.attributes.Status === "ERROR" || errors.length) {
      const error = errors[0];
      const number = error?.attributes.Number;
      const code = number && /^\d{1,10}$/.test(number) ? number : undefined;
      const message = error?.text ?? "";
      if (/too many requests|rate limit/i.test(message))
        failure("RATE_LIMITED", "Namecheap rate limited the request.", code);
      if (/\bIP\b|whitelist/i.test(message))
        failure(
          "PERMISSION_DENIED",
          "Whitelist the server's IPv4 address in Namecheap API settings.",
          code,
        );
      if (code === "1011102" || code === "1011150" || /api\s*key|apikey/i.test(message))
        failure("AUTHENTICATION_FAILED", "Namecheap rejected the API credentials.", code);
      if (code === "2019166" || code === "2016166")
        failure("DOMAIN_NOT_FOUND", "Namecheap could not find the domain.", code);
      if (code === "2030288")
        failure(
          "INVALID_CONFIGURATION",
          "DNS management requires Namecheap BasicDNS nameservers. The adapter never switches nameservers.",
          code,
        );
      failure("REQUEST_FAILED", "Namecheap rejected the request.", code);
    }
    if (root.attributes.Status !== "OK") malformed();
    return root;
  };

  const readHosts = async (zone: string, context: DnsProviderContext): Promise<HostSnapshot> => {
    const payload = result(await request(zone, "getHosts", context), "DomainDNSGetHostsResult");
    // Only a zone confirmed on BasicDNS is safe to replace with setHosts.
    if (payload.attributes.IsUsingOurDNS !== "true" && payload.attributes.IsUsingOurDNS !== "false")
      malformed();
    if (payload.attributes.IsUsingOurDNS === "false")
      throw new DomainSdkError(
        "INVALID_CONFIGURATION",
        "DNS management requires Namecheap BasicDNS nameservers.",
        { provider: "namecheap" },
      );
    const hosts = payload.children
      .filter((child) => child.name.toLowerCase() === "host")
      .map((child): Host => {
        const attributes = child.attributes;
        if (
          attributes.Name === undefined ||
          !attributes.Type ||
          attributes.Address === undefined ||
          !/^\d+$/.test(attributes.TTL ?? "") ||
          (attributes.MXPref !== undefined && !/^\d+$/.test(attributes.MXPref))
        )
          malformed();
        return {
          id: attributes.HostId,
          name: attributes.Name!,
          type: attributes.Type!.toUpperCase(),
          address: attributes.Address!,
          mxPref: attributes.MXPref,
          ttl: attributes.TTL!,
        };
      });
    return { hosts, emailType: payload.attributes.EmailType };
  };

  const write = (
    zone: string,
    context: DnsProviderContext,
    change: (hosts: Host[]) => Host[],
  ): Promise<void> => {
    const previous = queues.get(zone) ?? Promise.resolve();
    const pending = previous
      .catch(() => {})
      .then(async () => {
        const snapshot = await readHosts(zone, context);
        const hosts = change(snapshot.hosts);
        const parameters: Record<string, string> = {};
        if (snapshot.emailType !== undefined) parameters.EmailType = snapshot.emailType;
        hosts.forEach((host, index) => {
          const suffix = index + 1;
          parameters[`HostName${suffix}`] = host.name;
          parameters[`RecordType${suffix}`] = host.type;
          parameters[`Address${suffix}`] = host.address;
          parameters[`TTL${suffix}`] = host.ttl;
          if (host.mxPref !== undefined) parameters[`MXPref${suffix}`] = host.mxPref;
        });
        const payload = result(
          await request(zone, "setHosts", context, parameters),
          "DomainDNSSetHostsResult",
        );
        if (payload.attributes.IsSuccess !== "true") malformed();
        const after = await readHosts(zone, context);
        const expected = hosts.map((host) => hostKey(host, zone)).sort();
        const actual = after.hosts.map((host) => hostKey(host, zone)).sort();
        if (
          JSON.stringify(expected) !== JSON.stringify(actual) ||
          (snapshot.emailType !== undefined && snapshot.emailType !== after.emailType)
        )
          throw new DomainSdkError(
            "REQUEST_FAILED",
            "Namecheap did not retain the expected DNS records. Re-read the zone before retrying.",
            { provider: "namecheap" },
          );
      });
    queues.set(zone, pending);
    void pending
      .finally(() => {
        if (queues.get(zone) === pending) queues.delete(zone);
      })
      .catch(() => {});
    return pending;
  };

  return {
    id: "namecheap",
    capabilities: {
      recordTypes: ["A", "AAAA", "ALIAS", "CAA", "CNAME", "TXT"],
      ttl: { min: 60, max: 60000 },
      wholeZoneWrites: true,
      zoneInfo: true,
    },
    async listRecords({ zone }, context) {
      return (await readHosts(zone, context)).hosts.map((host) => zoneRecord(host, zone));
    },
    createRecords({ zone, records }, context) {
      if (!records.length) return Promise.resolve();
      return write(zone, context, (hosts) => [
        ...hosts,
        ...records.map(
          (record): Host => ({
            name: relativeRecordName(record.name, zone),
            type: record.type,
            address: record.value,
            ttl: String(record.ttl ?? ttl),
          }),
        ),
      ]);
    },
    deleteRecords({ zone, records }, context) {
      if (!records.length) return Promise.resolve();
      return write(zone, context, (hosts) => {
        // Consume matches one-for-one so one requested deletion removes at most one host,
        // even when identical hosts share a missing HostId.
        const pending = [...records];
        return hosts.filter((host) => {
          const current = zoneRecord(host, zone);
          const index = pending.findIndex(
            (record) =>
              record.id === current.id &&
              record.type === current.type &&
              record.name === current.name &&
              record.value === current.value &&
              record.ttl === current.ttl &&
              record.priority === current.priority,
          );
          if (index === -1) return true;
          pending.splice(index, 1);
          return false;
        });
      });
    },

    async getZone({ zone }, context) {
      const payload = result(await request(zone, "getList", context), "DomainDNSGetListResult");
      if (!["true", "false"].includes(payload.attributes.IsUsingOurDNS ?? "")) malformed();
      return {
        name: zone,
        provider: "namecheap",
        authoritative: payload.attributes.IsUsingOurDNS === "true",
        nameservers: payload.children
          .filter((child) => child.name === "Nameserver")
          .map((child) => child.text.trim().toLowerCase().replace(/\.$/, "")),
      };
    },
  };
}
