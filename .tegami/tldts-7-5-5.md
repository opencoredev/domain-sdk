---
subject: Update tldts to 7.5.5
packages:
  "@opencoredev/domain-sdk":
    type: patch
---

## Domain parsing dependency

Updated tldts from 7.5.4 to 7.5.5 for current public suffix data. The update adds 14 private suffixes, including `fastedge.app`, `gcorecdn.com`, `mailerpage.io`, `subscribepage.io`, `uncld.dev`, `loc.cc` and `*.2na.am`. The Netlify and Bunny adapters use private suffixes when they decide whether a hostname is an apex, so a name directly under one of these suffixes, such as `shop.mailerpage.io`, now counts as an apex there, and the suffix names themselves, such as `mailerpage.io` or `fastedge.app`, no longer count as apexes, so those adapters return the subdomain record for them instead of the apex record. Ordinary hostnames such as `www.example.co.uk` or `app.netlify.app` parse the same as before.
