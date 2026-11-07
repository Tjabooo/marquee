# Remote access and security

Marquee is built for a home network. Out of the box it listens on your LAN and treats everyone who
connects directly from it as one shared "Home network" account; anyone else has to sign in. Even so,
**don't forward Marquee's port on your router**: Marquee speaks plain HTTP, so passwords and video
would cross the internet unencrypted. Put something in front of it that adds HTTPS:

| Option | Good for | Accounts |
| --- | --- | --- |
| [Marquee's own sign-in](#marquees-own-sign-in) behind any of these | everyone | personal accounts with passwords |
| [Tailscale](#tailscale) | your own devices | one shared account |
| [Cloudflare Tunnel + Access](#cloudflare-tunnel-and-access) | family and friends, no VPN app | personal accounts, owner role, invites |
| [Reverse proxy with authentication](#reverse-proxy) | you already run Caddy or nginx with SSO | shared, or personal through a trusted header |

TLS on its own is not authentication. An HTTPS proxy without a login in front still lets everyone in.

## How accounts work

Each request belongs to one account, decided in this order:

1. **A proxy's identity.** `Cf-Access-Authenticated-User-Email`, set by Cloudflare Access or your
   authenticating proxy (only believed as described below).
2. **Marquee's own sign-in.** A session from the sign-in page at `/signin`.
3. **The shared Home network account**, for visitors connecting directly from the home network
   (private, loopback and Tailscale `100.64.0.0/10` addresses) while `HOME_NETWORK_ACCESS=shared`,
   the default. It is never an owner, and it's never given to visitors from the internet, not even
   through a tunnel or proxy: they get the sign-in page.

A person's account (library, progress, preferences) is the same whichever way they sign in with the
same email. Emails listed in `ADMIN_EMAILS` are owners (the first is the main owner, whose library
receives files added outside Marquee).

## Marquee's own sign-in

Accounts are created on the server, never over the network:

```sh
node setup.js user add you@example.com --owner   # asks for a password; --owner adds you to ADMIN_EMAILS
node setup.js user add friend@example.com
node setup.js user passwd friend@example.com      # new password; signs them out everywhere
node setup.js user signout friend@example.com     # end their sessions
node setup.js user remove friend@example.com      # their library and settings are kept
node setup.js user list
```

People sign in at `/signin` (Marquee sends them there) and can change their password and sign out in
Settings. Passwords are hashed with scrypt; sessions are random 256-bit tokens stored only as hashes,
in `HttpOnly; SameSite=Lax` cookies (`Secure` over HTTPS) that last `SESSION_DAYS` (30) unused.
After 5 wrong passwords an account waits 30 seconds, doubling up to 15 minutes, and an address with
30 misses in 15 minutes is locked out for 15 minutes.

To make everyone sign in, at home too, set `HOME_NETWORK_ACCESS=signin`. Smart TVs fetching
subtitles from the server's LAN address keep working.

### Requests Marquee refuses

- **From other websites.** A page you open could otherwise make your browser send requests to
  Marquee on your LAN (CSRF). Changes are accepted only from Marquee's own pages (`Origin` and
  `Sec-Fetch-Site` checks); tools without a browser, like the House and Screen Time agents, are
  unaffected.
- **For unknown host names.** A malicious site can point its own domain at your server's LAN
  address (DNS rebinding). Marquee answers only to IP addresses, `localhost`, single-label names
  (`http://nas:8080`), home-network suffixes (`.local`, `.lan`, `.home.arpa`, `.internal`, `.ts.net`),
  `PUBLIC_URL`'s host and `ALLOWED_HOSTS`. Requests through Cloudflare are exempt, since Cloudflare
  only routes your own hostnames. If you use another name, add it to `ALLOWED_HOSTS`.

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
leads to the protected app), open invite links, the Marquee preview card, and the Jellyfin plugin's
API under `/c/jf/` (every call there needs a connected server's key or a link signed for one video;
see [jellyfin.md](jellyfin.md)). `/api/house/*` and
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
