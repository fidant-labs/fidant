# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub, not in a public issue:
[report a vulnerability](https://github.com/fidant-labs/fidant/security/advisories/new). We'll reply there.

Don't include real files, transfer links or personal data in a report.

## Supported versions

Only the current `main` branch gets security fixes. [fidant.se](https://fidant.se) runs the `production` branch, which a maintainer moves forward to a commit on `main`'s first-parent history, so a fix reaches the site when it is promoted.

## Scope

Fidant encrypts files in the sender's browser, and no infrastructure (our servers, relay, hosts or email) should be able to read file content, file names, file metadata or keys. Anything that breaks that promise is in scope, for example:

- a key, file content, file name or file metadata reaching the server, the relay or a log
- a way to open a transfer without its link
- a changed or damaged file being saved by the recipient
- XSS, CSP or header weaknesses in the web client
- weaknesses in the signaling server or the AWS infrastructure in `apps/infra`

What counts as a leak is defined in [docs/decisions/0001-e2e-tests-and-leak-model.md](docs/decisions/0001-e2e-tests-and-leak-model.md).

These are known limits, not vulnerabilities (see the [security page](https://fidant.se/security)):

- anyone who has a transfer link can open the file
- the sender's name is not verified
- the two browsers, and the relay when it is used, see each other's IP addresses and roughly the file size
- an already compromised computer can read the file before encryption or after decryption

Fidant has not been independently audited yet.
