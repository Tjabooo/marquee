# Security

## Reporting a vulnerability

Please report security problems privately through GitHub's
[private vulnerability reporting](https://github.com/Tjabooo/lilin/security/advisories/new)
rather than in a public issue. Include the version (`node setup.js doctor` prints it), what an
attacker needs (network position, account) and how to reproduce it.

Fixes go into the latest release; there are no long-term support branches.

## Security model

- **Who's asking**: a verified Cloudflare Access token or a trusted proxy's identity header, else
  Lilin's own sign-in (scrypt password hashes, random 256-bit session tokens stored only as
  SHA-256 hashes, `HttpOnly; SameSite=Lax` cookies, per-account backoff and per-address lockout),
  else the shared Home network account, which is given only to visitors connecting directly from a
  private, loopback or Tailscale address, and only while `HOME_NETWORK_ACCESS=shared`. A visitor
  from the internet without an identity gets the sign-in page.
- **Unwanted requests**: state-changing requests whose `Origin`/`Sec-Fetch-Site` shows another site
  are refused (CSRF), as are requests for host names Lilin doesn't know (DNS rebinding). Responses
  forbid framing by other sites and MIME sniffing.
- **Accounts are created on the server** (`node setup.js user ...`), never over the network.
- **Windows autostart** runs Lilin as your account without elevation; nothing runs as SYSTEM.
  The installer limits write access to the Lilin folder to you, SYSTEM and administrators.
- **Clipper** (optional) is pinned to a reviewed commit and checked against a SHA-256 tree hash
  before it runs; the commands for other PCs verify the installer's checksum first.
- Lilin serves plain HTTP. Exposing its port directly to the internet is unsupported: put HTTPS
  in front (Cloudflare Tunnel, Tailscale, a reverse proxy). Details: [docs/remote-access.md](docs/remote-access.md).
