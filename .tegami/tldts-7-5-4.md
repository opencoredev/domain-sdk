---
subject: Update tldts to 7.5.4
packages:
  "@opencoredev/domain-sdk":
    type: patch
---

## Domain parsing dependency

Updated tldts from 7.4.19 to 7.5.4 for current public suffix data and upstream parsing fixes. One visible change: a name that is itself the parent of a wildcard suffix rule, such as `kawasaki.jp` (the list has `*.kawasaki.jp`), now counts as a public suffix, so it no longer resolves to a registrable domain. Ordinary hostnames such as `www.example.co.uk` or `app.netlify.app` parse the same as before.
