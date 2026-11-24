import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { extractFaq, faqPageSchema } from "./faq";

const page = `# Title

## Setup

### Not a question

Body text.

## Common questions

### Is the **API** free?

Yes. See [pricing](https://example.com/pricing) and \`createDnsClient\`.

\`\`\`ts
const ignored = "### not a heading";
\`\`\`

It has _limits_.

### Empty answer?

### Last one?

Final answer.

Read next: [Other](./other.mdx).

## Next steps

- [Link](/docs)
`;

describe("extractFaq", () => {
  test("reads questions and plain-text answers from the Q&A section only", () => {
    assert.deepEqual(extractFaq(page), [
      {
        question: "Is the API free?",
        answer: "Yes. See pricing and createDnsClient. It has limits.",
      },
      { question: "Last one?", answer: "Final answer." },
    ]);
  });

  test("accepts an FAQ heading", () => {
    assert.deepEqual(extractFaq("## FAQ\n\n### Q?\n\nA.\n"), [{ question: "Q?", answer: "A." }]);
  });

  test("keeps asterisks inside inline code", () => {
    assert.deepEqual(
      extractFaq(
        "## FAQ\n\n### What is it?\n\nA label of `*`, such as `*.example.com`, see [`waitUntilActive`](./poll.mdx).\n",
      ),
      [
        {
          question: "What is it?",
          answer: "A label of *, such as *.example.com, see waitUntilActive.",
        },
      ],
    );
  });

  test("drops the heading anchors that processed Markdown adds", () => {
    assert.deepEqual(
      extractFaq(
        "## Common questions [#common-questions]\n\n### Is `*` free? [#is--free]\n\nYes.\n",
      ),
      [{ question: "Is * free?", answer: "Yes." }],
    );
  });

  test("returns nothing without a Q&A section", () => {
    assert.deepEqual(extractFaq("## Setup\n\n### Step\n\nText.\n"), []);
  });

  test("keeps snake_case and underscores in identifiers", () => {
    assert.deepEqual(
      extractFaq("## FAQ\n\n### What is netlify_site_id?\n\nUse NETLIFY_SITE_ID.\n"),
      [{ question: "What is netlify_site_id?", answer: "Use NETLIFY_SITE_ID." }],
    );
  });
});

describe("faqPageSchema", () => {
  test("builds a FAQPage node", () => {
    assert.deepEqual(
      faqPageSchema({ url: "https://x.dev/p", entries: [{ question: "Q?", answer: "A." }] }),
      {
        "@type": "FAQPage",
        "@id": "https://x.dev/p#faq",
        url: "https://x.dev/p",
        mainEntity: [
          { "@type": "Question", name: "Q?", acceptedAnswer: { "@type": "Answer", text: "A." } },
        ],
      },
    );
  });

  test("returns undefined for no entries", () => {
    assert.equal(faqPageSchema({ url: "https://x.dev/p", entries: [] }), undefined);
  });
});
