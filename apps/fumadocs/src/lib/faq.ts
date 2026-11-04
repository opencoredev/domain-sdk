/** One question and its plain-text answer, taken from a page's Q&A section. */
export type FaqEntry = {
  question: string;
  answer: string;
};

// Processed Markdown appends the heading anchor, as in `## FAQ [#faq]`.
const headingAnchor = /\s*\[#[^\]]*\]\s*$/;
const faqHeading = /^##\s+(?:FAQ|Common questions|Frequently asked questions)$/i;

/** Turns inline Markdown into the text a reader sees. */
function toPlainText(markdown: string): string {
  // Odd parts are inline code, kept verbatim so `*.example.com` isn't read as emphasis.
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .split(/`([^`]+)`/)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .replace(/(\*\*|__)(.+?)\1/g, "$2")
            .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
            .replace(/<[^>]+>/g, ""),
    )
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Reads the `## FAQ` / `## Common questions` section of a page's Markdown.
 * Each `###` heading is a question and the prose under it is the answer.
 * Code blocks and "Read next" lines are left out, so the answer matches the
 * visible text without samples. Returns an empty list when the page has no
 * such section.
 */
export function extractFaq(markdown: string): FaqEntry[] {
  const entries: FaqEntry[] = [];
  let inSection = false;
  let inFence = false;
  let question: string | undefined;
  let answerLines: string[] = [];

  const flush = () => {
    if (question === undefined) return;
    const answer = toPlainText(answerLines.join(" "));
    if (answer) entries.push({ question: toPlainText(question), answer });
    question = undefined;
    answerLines = [];
  };

  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (/^##\s/.test(line)) {
      flush();
      inSection = faqHeading.test(line.replace(headingAnchor, "").trim());
      continue;
    }
    if (!inSection) continue;

    const questionMatch = /^###\s+(.+?)\s*$/.exec(line);
    if (questionMatch) {
      flush();
      question = questionMatch[1].replace(headingAnchor, "");
      continue;
    }
    if (question === undefined || /^\s*Read next:/i.test(line)) continue;
    answerLines.push(line);
  }
  flush();

  return entries;
}

/** A schema.org `FAQPage` node for the entries, or `undefined` when there are none. */
export function faqPageSchema({ url, entries }: { url: string; entries: FaqEntry[] }) {
  if (entries.length === 0) return undefined;
  return {
    "@type": "FAQPage",
    "@id": `${url}#faq`,
    url,
    mainEntity: entries.map((entry) => ({
      "@type": "Question",
      name: entry.question,
      acceptedAnswer: { "@type": "Answer", text: entry.answer },
    })),
  };
}
