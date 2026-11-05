# Remote access and security

Marquee is built for a home network. Out of the box it listens on your LAN, has no login screen and
treats everyone on the network as one shared "Home network" account. That is fine at home and unsafe
anywhere else: **never forward Marquee's port on your router or expose it directly to the internet.**
Anyone who can reach it can browse, start downloads and delete files.

To use Marquee away from home, put something in front of it that authenticates people first:

| Option | Good for | Accounts |
| --- | --- | --- |
| [Tailscale](#tailscale) | your own devices | one shared account |
| [Cloudflare Tunnel + Access](#cloudflare-tunnel-and-access) | family and friends, no VPN app | personal accounts, owner role, invites |
| [Reverse proxy with authentication](#reverse-proxy) | you already run Caddy or nginx with SSO | shared, or personal through a trusted header |

TLS on its own is not authentication. An HTTPS proxy without a login in front still lets everyone in.

## How accounts work

Marquee has no passwords of its own. It reads who someone is from a header set by an
authenticating proxy, `Cf-Access-Authenticated-User-Email`:

- A request with that header is that person's account: their library, progress and preferences.
  Accounts are created on first visit. Emails listed in `ADMIN_EMAILS` are owners (the first is the
  main owner, whose library receives files added outside Marquee).
- A request without it is the shared **Home network** account, which is never an owner.

Because any client can send any header, Marquee only believes identity and proxy headers
(`Cf-Access-*`, `Cf-Connecting-IP`, `Cf-Ray`, `X-Forwarded-*`) when one of these holds:

1. **The connection comes from a trusted proxy.** `TRUSTED_PROXIES` lists addresses or CIDR ranges;
   the default is `127.0.0.1,::1`, which covers cloudflared or a proxy running on the same machine.
   Headers on connections from anywhere else are removed before the request is handled, so a device
   on your LAN that sends `Cf-Access-Authenticated-User-Email: owner@example.com` gets the Home
   network account, not the owner's.
2. **The request carries a valid Cloudflare Access token.** With `CF_ACCESS_TEAM_DOMAIN` and
   `CF_ACCESS_AUD` set, Marquee verifies the `Cf-Access-Jwt-Assertion` header (or the
   `CF_Authorization` cookie) against your team's published signing keys: RS256 signature, audience,
   issuer and expiry. The email comes from the verified token; a request without a valid token gets
   no identity, even from a trusted proxy. Use this when cloudflared runs on another machine or in
   another container, or whenever you want the strongest guarantee.

Marquee logs which mode it uses at startup (`Accounts: ...`).

### What stays public

`/c/...` is reachable without signing in by design, and you must exclude it from Access (see
below): it serves only clips you chose to share, link previews of notes you shared (clicking one
leads to the protected app), open invite links, and the Marquee preview card. `/api/house/*` and
`/api/screentime` accept requests only with `HOUSE_TOKEN` / `SCREENTIME_TOKEN`, and House reports
are refused when they come through Cloudflare.

## Tailscale

The simplest private option: Marquee stays LAN-only, and your devices reach it through your tailnet.

1. Install Tailscale on the Marquee machine and on your phone/laptop, signed in to the same tailnet.
2. Open `http://<machine name>:8080` (MagicDNS) or `http://<100.x.y.z>:8080` from any of them.

Everyone on the tailnet shares the Home network account. Casting to TVs works only for visitors
Marquee sees as being at home (`CAST_WHEN_AWAY=on` changes that). To restrict who in the tailnet can
reach the port, use Tailscale ACLs. `tailscale serve` can add HTTPS; it does not add accounts.

## Cloudflare Tunnel and Access

This gives each person their own account without a VPN app: Cloudflare Access signs people in
(Google, one-time email codes, and so on) and the tunnel carries the traffic, so no port is opened
on your router.

1. **Tunnel.** In Cloudflare Zero Trust → Networks → Tunnels, create a tunnel and install cloudflared
   on the Marquee machine. Add a public hostname, e.g. `marquee.example.com`, with the service
   `http://localhost:8080`. cloudflared then connects from `127.0.0.1`, which the default
   `TRUSTED_PROXIES` already trusts.
2. **Access application.** Zero Trust → Access → Applications → Add → Self-hosted, for
   `marquee.example.com`. Add a policy that allows your people (an email list works well; see
   [Invites](#invites)). Under the application's settings, copy the **Application Audience (AUD) tag**.
3. **Public paths.** Add a second self-hosted application for `marquee.example.com/c` with a
   **Bypass** policy for Everyone, so shared clips, note previews and invites open without signing in.
4. **Marquee settings** (`node setup.js` asks for these when you pick Cloudflare):

   ```ini
   ADMIN_EMAILS=you@example.com
   PUBLIC_URL=https://marquee.example.com
   CF_ACCESS_TEAM_DOMAIN=yourteam.cloudflareaccess.com
   CF_ACCESS_AUD=<the AUD tag>
   ```

   `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD` are optional when cloudflared runs on the same machine,
   and required for a correct setup when it doesn't (e.g. cloudflared in its own container). Without
   them, set `TRUSTED_PROXIES` to cloudflared's address, and make sure nothing else can connect from
   that address.
5. Restart Marquee and run `node setup.js doctor`: it checks that the team's signing keys are reachable.

Sign-in duration is Cloudflare's setting (Access → Applications → Session duration). Location in the
Activity tab comes from Cloudflare's visitor location headers (Rules → Managed Transforms → "Add
visitor location headers").

### Invites

Owners can create one-time invite links in Marquee. Whoever opens one enters their email, and
Marquee adds it to the Zero Trust email list your Access policy allows.

1. Zero Trust → Reusable components → Lists: create an email list and use it in the Marquee
   application's Allow policy. Copy the list ID from its URL.
2. Create an API token (My Profile → API Tokens) with the account permission **Zero Trust: Edit**.
3. Set `CF_API_TOKEN`, `CF_ACCOUNT_ID` and `CF_ACCESS_LIST_ID`. `node setup.js doctor` reads the list
   to confirm all three work together.

Invite links expire after `INVITE_DAYS` and work once. Send them privately.

## Reverse proxy

If you already run a reverse proxy with an authentication layer (Authelia, Authentik, oauth2-proxy,
Caddy's `forward_auth`, nginx `auth_request`), Marquee can sit behind it.

- Bind Marquee to the proxy: `HOST=127.0.0.1` when the proxy is on the same machine, otherwise keep
  `HOST=0.0.0.0` and firewall the port so only the proxy can connect.
- Without personal accounts, the proxy only needs to authenticate; everyone shares one account.
- For personal accounts, have the proxy set `Cf-Access-Authenticated-User-Email` to the
  authenticated user's email **and strip any copy the client sent**, and list the proxy's address in
  `TRUSTED_PROXIES`. Marquee trusts that header from that address only.

Caddy with forward auth (Authelia shown; adjust to your provider):

```caddy
marquee.example.com {
	forward_auth authelia:9091 {
		uri /api/authz/forward-auth
		copy_headers Remote-Email
	}
	reverse_proxy 127.0.0.1:8080 {
		header_up -Cf-Access-Authenticated-User-Email
		header_up Cf-Access-Authenticated-User-Email {http.request.header.Remote-Email}
	}
}
```

nginx with `auth_request`:

```nginx
server {
    listen 443 ssl;
    server_name marquee.example.com;
    # ssl_certificate ...;

    location = /authz {
        internal;
        proxy_pass http://authelia:9091/api/authz/auth-request;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header X-Original-Method $request_method;
        proxy_set_header X-Original-URL $scheme://$http_host$request_uri;
    }

    location / {
        auth_request /authz;
        auth_request_set $email $upstream_http_remote_email;
        proxy_set_header Cf-Access-Authenticated-User-Email $email;   # replaces anything the client sent
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_buffering off;              # live updates (server-sent events) and video streaming
        proxy_read_timeout 1h;
        client_max_body_size 0;           # Notes uploads are chunked, but don't cap them
        proxy_pass http://127.0.0.1:8080;
    }

    location /c/ {                        # public share links, no login
        proxy_set_header Host $host;
        proxy_pass http://127.0.0.1:8080;
    }
}
```

With either proxy on another host, set `TRUSTED_PROXIES` to that host's address.

## Keeping it safe

- `.env` holds API keys and passwords. `setup.js` creates it readable only by you; keep it that way
  and out of backups you share.
- Keep Marquee and Node.js updated (`node setup.js doctor` shows versions).
- Downloads and deletions are available to every account the owner allows (Settings → who may
  download). The Home network account can download too unless the owner turns that off.

## Future: built-in sign-in (proposal)

Marquee deliberately relies on an external identity provider today. A built-in login is planned as
separate, careful work rather than a quick addition. The intended design:

- **Opt-in** (`AUTH=local`), so existing Cloudflare Access setups are unaffected; both can coexist,
  with the proxy identity taking precedence when verified.
- **Passkeys (WebAuthn) first**, with optional passwords hashed with scrypt (Node's built-in
  `crypto.scrypt`, so still no dependencies) and per-account rate limiting with backoff.
- **Server-side sessions** in `.marquee.db`: random 256-bit IDs in `HttpOnly; Secure; SameSite=Lax`
  cookies, idle and absolute expiry, listing and revoking sessions per account, rotation on sign-in.
- **CSRF protection** for every state-changing request (Origin check plus a per-session token),
  which the current header-based model does not need.
- **Bootstrap**: the first owner is created from the server console (`node setup.js owner add`), never
  from the network; invites become sign-up links that work without Cloudflare.
- **LAN mode stays available** as an explicit choice (`HOME_NETWORK_ACCESS=shared|signin`), so a
  household can keep the current no-login experience at home.
