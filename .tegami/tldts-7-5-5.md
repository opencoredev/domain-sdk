---
subject: Update tldts to 7.5.5
packages:
  "@opencoredev/domain-sdk":
    type: patch
---

## Domain parsing dependency

Updated tldts from 7.5.4 to 7.5.5 for current public suffix data. The update adds 14 private suffixes, including `fastedge.app`, `gcorecdn.com`, `mailerpage.io`, `subscribepage.io`, `uncld.dev`, `loc.cc` and `*.2na.am`. The Netlify and Bunny adapters use private suffixes when they decide whether a hostname is an apex, so their output changes in two ways for names under these suffixes. A name one label below a new suffix, such as `shop.mailerpage.io`, now counts as an apex and gets the apex record. A name that used to count as an apex but is now a suffix, such as `mailerpage.io`, `fastedge.app`, or `2na.am` (the parent of the `*.2na.am` wildcard rule), now gets the subdomain record instead. Ordinary hostnames such as `www.example.co.uk` or `app.netlify.app` parse the same as before.
