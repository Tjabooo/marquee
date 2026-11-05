# Security

## Reporting a vulnerability

Please report security problems privately through GitHub's
[private vulnerability reporting](https://github.com/Tjabooo/marquee/security/advisories/new)
rather than in a public issue. Include the version (`node setup.js doctor` prints it), what an
attacker needs (network position, account) and how to reproduce it.

Fixes go into the latest release; there are no long-term support branches.

## Security model

Marquee is designed for a trusted home network and has no login of its own. Identity comes from an
authenticating proxy, and Marquee only believes identity headers from trusted proxies or with a
verified Cloudflare Access token. Exposing Marquee directly to the internet is unsupported. Details,
deployment options and the planned built-in sign-in: [docs/remote-access.md](docs/remote-access.md).
