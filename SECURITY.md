# Security Policy

## Supported Versions

Pongreay is currently pre-1.0. Security fixes are released on the latest
published version.

## Reporting a Vulnerability

Please report suspected vulnerabilities privately by emailing
titpanhara@gmail.com.

Include:

- affected Pongreay version
- operating system and Node.js version
- reproduction steps or proof of concept
- impact and any known workaround

Please do not open a public GitHub issue for sensitive reports. Public issues
are welcome for hardening ideas, documentation gaps, and non-sensitive defects.

## Security Model

Pongreay is a deployment CLI. It intentionally invokes local tools such as
`git`, `docker`, `ssh`, and `scp`, and it runs a constrained remote deployment
script on the configured server.

Pongreay should be installed only from the official npm package and used only
with configuration files you trust.
