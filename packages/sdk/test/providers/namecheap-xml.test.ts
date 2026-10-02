import { expect, test } from "bun:test";
import { DomainSdkError } from "../../src/core/errors";
import { parseXml } from "../../src/providers/namecheap/xml";

test("parses declarations, comments, nested tags, and both attribute quotes", () => {
  expect(
    parseXml(`\ufeff<?xml version="1.0" encoding='utf-8' standalone="yes"?>
      <!-- before -->
      <ApiResponse Status="OK" xmlns='http://api.namecheap.com/xml.response'>
        <CommandResponse Type='namecheap.domains.dns.getHosts'>
          <DomainDNSGetHostsResult EmailType="MX" IsUsingOurDNS='true'>
            <host HostId='1' Name="@" Type='A' Address="192.0.2.1" TTL='1800'/>
          </DomainDNSGetHostsResult>
        </CommandResponse>
      </ApiResponse><!-- after -->`),
  ).toMatchObject({
    name: "ApiResponse",
    attributes: { Status: "OK", xmlns: "http://api.namecheap.com/xml.response" },
    children: [
      {
        name: "CommandResponse",
        children: [
          {
            name: "DomainDNSGetHostsResult",
            attributes: { EmailType: "MX", IsUsingOurDNS: "true" },
            children: [
              {
                name: "host",
                attributes: {
                  HostId: "1",
                  Name: "@",
                  Type: "A",
                  Address: "192.0.2.1",
                  TTL: "1800",
                },
                children: [],
                text: "",
              },
            ],
          },
        ],
      },
    ],
  });
});

test("preserves direct text and decodes built-in and numeric entities once", () => {
  expect(
    parseXml(
      `<root value='&quot;&apos;&amp;&lt;&gt;&#65;&#x1F600;'>before &amp;lt;<child>inside</child><!-- ignore -->after &#10;</root>`,
    ),
  ).toEqual({
    name: "root",
    attributes: { value: `"'&<>A😀` },
    children: [{ name: "child", attributes: {}, children: [], text: "inside" }],
    text: "before &lt;after \n",
  });
});

test("accepts XML names, whitespace, empty tags, and line ending normalization", () => {
  expect(
    parseXml("\r\n<ns:élément data-id = 'line\r\nbreak&#10;end'>a\r\nb\rc<空 /></ns:élément >\t"),
  ).toEqual({
    name: "ns:élément",
    attributes: { "data-id": "line break\nend" },
    children: [{ name: "空", attributes: {}, children: [], text: "" }],
    text: "a\nb\nc",
  });
});

test("treats prototype-like attribute names as ordinary own properties", () => {
  const element = parseXml(`<root __proto__="safe" constructor="safe" toString="safe"/>`);
  expect(Object.getPrototypeOf(element.attributes)).toBe(Object.prototype);
  expect(Object.keys(element.attributes)).toEqual(["__proto__", "constructor", "toString"]);
  expect(element.attributes.__proto__).toBe("safe");
});

const malformed = [
  "",
  " \n",
  "text",
  "<root>",
  "<root><child></root></child>",
  "<root></other>",
  "</root>",
  "<root/><other/>",
  "<root/>text",
  "text<root/>",
  "<root/>&#32;",
  "<root",
  "<root/ >",
  "< root/>",
  "<1root/>",
  "<root></root extra>",
  "<root></root/>",
  "<root attribute/>",
  "<root attribute=value/>",
  '<root attribute="value/>',
  '<root attribute="a"attribute2="b"/>',
  '<root attribute="a" attribute="b"/>',
  '<root attribute="<child>"/>',
  '<root ="value"/>',
  '<root attribute=="value"/>',
  "<root>&unknown;</root>",
  "<root>&constructor;</root>",
  "<root>&amp</root>",
  "<root>&;</root>",
  "<root>&amp &lt;</root>",
  "<root>&#;</root>",
  "<root>&#x;</root>",
  "<root>&#X41;</root>",
  "<root>&#-1;</root>",
  "<root>&# 65;</root>",
  "<root>&#65oops;</root>",
  "<root>&#xgg;</root>",
  "<root>&#0;</root>",
  "<root>&#11;</root>",
  "<root>&#xD800;</root>",
  "<root>&#xFFFE;</root>",
  "<root>&#x110000;</root>",
  "<root>&#99999999999999999999999999999999;</root>",
  '<root attribute="&unknown;"/>',
  '<root attribute="&amp"/>',
  "<root>]]></root>",
  "<root>\u0000</root>",
  "<root>\ud800</root>",
  "<root>\uffff</root>",
  "<!-- unfinished<root/>",
  "<!-- invalid -- comment --><root/>",
  "<!-- invalid ---><root/>",
  "<!DOCTYPE root><root/>",
  '<!DOCTYPE root [<!ENTITY secret "value">]><root/>',
  '<!ENTITY secret "value"><root/>',
  "<root><![CDATA[text]]></root>",
  "<!OTHER><root/>",
  "<?other instruction?><root/>",
  " <?xml version='1.0'?><root/>",
  "<!-- before --><?xml version='1.0'?><root/>",
  "<root><?xml version='1.0'?></root>",
  "<?xml?><root/>",
  "<?xml version='1.1'?><root/>",
  "<?xml version='1.0'/><root/>",
  "<?xml version='1.0' extra='value'?><root/>",
  "<?xml version='1.0' standalone='maybe'?><root/>",
  "<?xml encoding='utf-8' version='1.0'?><root/>",
  "<?xml version='1.0' standalone='yes' encoding='utf-8'?><root/>",
  "<?xml version='1.0' encoding='1utf'?><root/>",
  "<?xml version='&#49;.0'?><root/>",
  "<?xml version='1.0' encoding='utf&#45;8'?><root/>",
  "<?xml version='1.0'?><?xml version='1.0'?><root/>",
];

for (const input of malformed) {
  test(`rejects malformed XML case ${malformed.indexOf(input) + 1} without echoing input`, () => {
    let error: unknown;
    try {
      parseXml(input);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DomainSdkError);
    expect(error).toMatchObject({
      code: "REQUEST_FAILED",
      provider: "namecheap",
      message: "Invalid XML response from provider.",
      details: undefined,
      cause: undefined,
    });
  });
}

test("caps XML nesting at 100, including self-closing elements", () => {
  expect(() => parseXml("<root>".repeat(100) + "</root>".repeat(100))).not.toThrow();
  expect(() => parseXml("<root>".repeat(99) + "<leaf/>" + "</root>".repeat(99))).not.toThrow();
  expect(() => parseXml("<root>".repeat(101) + "</root>".repeat(101))).toThrow(DomainSdkError);
  expect(() => parseXml("<root>".repeat(100) + "<leaf/>" + "</root>".repeat(100))).toThrow(
    DomainSdkError,
  );
});

test("caps input at one MiB of UTF-8, accepting the exact boundary", () => {
  const availableBytes = 1_048_576 - "<root></root>".length;
  expect(() => parseXml(`<root>${"a".repeat(availableBytes)}</root>`)).not.toThrow();
  expect(() => parseXml(`<root>${"a".repeat(availableBytes + 1)}</root>`)).toThrow(DomainSdkError);
  expect(() =>
    parseXml(`<root>${"é".repeat(Math.floor(availableBytes / 2))}</root>`),
  ).not.toThrow();
  expect(() => parseXml(`<root>${"é".repeat(Math.floor(availableBytes / 2) + 1)}</root>`)).toThrow(
    DomainSdkError,
  );
});

test("rejects large unterminated entity sequences without repeated scans", () => {
  expect(() => parseXml(`<root>${"&".repeat(100_000)}</root>`)).toThrow(DomainSdkError);
});
