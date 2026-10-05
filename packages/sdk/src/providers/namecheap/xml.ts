import { DomainSdkError } from "../../core/errors";

export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  text: string;
}

export const MAX_XML_BYTES = 1_048_576;
const MAX_DEPTH = 100;
const XML_NAME_START =
  /[:A-Z_a-z\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u02ff\u0370-\u037d\u037f-\u1fff\u200c-\u200d\u2070-\u218f\u2c00-\u2fef\u3001-\ud7ff\uf900-\ufdcf\ufdf0-\ufffd\u{10000}-\u{effff}]/u;
const XML_NAME_EXTRA = /[-.0-9\u00b7\u203f-\u2040]|[\u0300-\u036f]/u;
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function invalidXml(): never {
  throw new DomainSdkError("REQUEST_FAILED", "Invalid XML response from provider.", {
    provider: "namecheap",
  });
}

function validCharacter(codePoint: number): boolean {
  return (
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0d ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

function decodeEntities(value: string): string {
  const decoded: string[] = [];
  let position = 0;
  while (position < value.length) {
    const start = value.indexOf("&", position);
    if (start === -1) break;
    decoded.push(value.slice(position, start));
    const end = value.indexOf(";", start + 1);
    if (end === -1) return invalidXml();
    const entity = value.slice(start + 1, end);
    if (Object.hasOwn(ENTITIES, entity)) decoded.push(ENTITIES[entity]!);
    else {
      if (!/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entity)) return invalidXml();
      const hexadecimal = entity.startsWith("#x");
      const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      if (!validCharacter(codePoint)) return invalidXml();
      decoded.push(String.fromCodePoint(codePoint));
    }
    position = end + 1;
  }
  decoded.push(value.slice(position));
  return decoded.join("");
}

export function parseXml(input: string): XmlElement {
  if (input.length > MAX_XML_BYTES || new TextEncoder().encode(input).length > MAX_XML_BYTES) {
    return invalidXml();
  }
  for (const character of input) {
    if (!validCharacter(character.codePointAt(0)!)) return invalidXml();
  }
  const source = input.replace(/\r\n?/g, "\n");
  let position = source.startsWith("\ufeff") ? 1 : 0;
  const documentStart = position;
  let root: XmlElement | undefined;
  const stack: XmlElement[] = [];

  function skipWhitespace(): boolean {
    const start = position;
    while (position < source.length && /[\t\n\r ]/.test(source[position]!)) position++;
    return position > start;
  }

  function readName(): string {
    const start = position;
    const firstCodePoint = source.codePointAt(position);
    if (firstCodePoint === undefined) return invalidXml();
    const first = String.fromCodePoint(firstCodePoint);
    if (!XML_NAME_START.test(first)) return invalidXml();
    position += first.length;
    while (position < source.length) {
      const character = String.fromCodePoint(source.codePointAt(position)!);
      if (!XML_NAME_START.test(character) && !XML_NAME_EXTRA.test(character)) break;
      position += character.length;
    }
    return source.slice(start, position);
  }

  function readAttributes(terminator: string, allowEntities = true): Record<string, string> {
    const attributes: Record<string, string> = {};
    while (position < source.length) {
      const separated = skipWhitespace();
      if (source.startsWith(terminator, position) || source.startsWith("/>", position)) {
        return attributes;
      }
      if (!separated) return invalidXml();
      const name = readName();
      if (Object.hasOwn(attributes, name)) return invalidXml();
      skipWhitespace();
      if (source[position++] !== "=") return invalidXml();
      skipWhitespace();
      const quote = source[position++];
      if (quote !== '"' && quote !== "'") return invalidXml();
      const end = source.indexOf(quote, position);
      if (end === -1) return invalidXml();
      const value = source.slice(position, end);
      if (value.includes("<") || (!allowEntities && value.includes("&"))) return invalidXml();
      Object.defineProperty(attributes, name, {
        value: decodeEntities(value.replace(/[\t\n\r]/g, " ")),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      position = end + 1;
    }
    return invalidXml();
  }

  while (position < source.length) {
    if (source.startsWith("<!--", position)) {
      const end = source.indexOf("-->", position + 4);
      if (end === -1) return invalidXml();
      const comment = source.slice(position + 4, end);
      if (comment.includes("--") || comment.endsWith("-")) return invalidXml();
      position = end + 3;
      continue;
    }
    if (source.startsWith("<?", position)) {
      if (position !== documentStart || !source.startsWith("<?xml", position)) return invalidXml();
      position += 5;
      const attributes = readAttributes("?>", false);
      const names = Object.keys(attributes);
      if (
        attributes.version !== "1.0" ||
        names[0] !== "version" ||
        names.some((name) => !["version", "encoding", "standalone"].includes(name)) ||
        (attributes.encoding !== undefined &&
          !/^[A-Za-z][A-Za-z0-9._-]*$/.test(attributes.encoding)) ||
        (attributes.standalone !== undefined && !/^(yes|no)$/.test(attributes.standalone)) ||
        (names.includes("encoding") &&
          names.includes("standalone") &&
          names.indexOf("encoding") > names.indexOf("standalone")) ||
        !source.startsWith("?>", position)
      ) {
        return invalidXml();
      }
      position += 2;
      continue;
    }
    if (source.startsWith("<!", position)) return invalidXml();
    if (source.startsWith("</", position)) {
      position += 2;
      const name = readName();
      skipWhitespace();
      if (source[position++] !== ">" || stack.pop()?.name !== name) return invalidXml();
      continue;
    }
    if (source[position] === "<") {
      position++;
      const name = readName();
      const attributes = readAttributes(">");
      const selfClosing = source.startsWith("/>", position);
      if (!selfClosing && source[position] !== ">") return invalidXml();
      position += selfClosing ? 2 : 1;
      if (stack.length >= MAX_DEPTH) return invalidXml();
      const element: XmlElement = { name, attributes, children: [], text: "" };
      const parent = stack.at(-1);
      if (parent) parent.children.push(element);
      else if (root) return invalidXml();
      else root = element;
      if (!selfClosing) stack.push(element);
      continue;
    }
    const nextTag = source.indexOf("<", position);
    const end = nextTag === -1 ? source.length : nextTag;
    const text = source.slice(position, end);
    const parent = stack.at(-1);
    if (parent) {
      if (text.includes("]]>")) return invalidXml();
      parent.text += decodeEntities(text);
    } else if (!/^[\t\n\r ]*$/.test(text)) return invalidXml();
    position = end;
  }
  if (!root || stack.length !== 0) return invalidXml();
  return root;
}
