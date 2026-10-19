# Self-hosting Presio

The whole Presio stack runs from **one `docker-compose.yml` at the repo root**,
fronted by a small shared **Traefik** reverse proxy (in [`proxy/`](../proxy)) that
terminates TLS and routes your domains. The proxy is a separate, host-level
project so you can run other apps behind the same proxy later — see
[Adding more apps](#adding-more-apps-to-the-same-host).

```
                       host :80 / :443
                             │
                       ┌─────▼─────┐        external docker network "web"
                       │  traefik  │◄──────────────┬────────────────┐
                       │ (proxy/)  │               │                │
                       └───────────┘         presio-app:3001   (future app)
                                              supabase-kong:8000
```

| Service group    | What it is                                                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `presio`         | The app — Express + Socket.IO server that also serves the built React client (built by `deploy/Dockerfile`).                                                      |
| `kong` + `*`     | A pinned, self-hosted [Supabase](https://supabase.com/docs/guides/self-hosting/docker) stack — Postgres, GoTrue (auth), Storage, PostgREST, Kong gateway, Studio. |
| `minio`          | [MinIO](https://min.io) object store; Supabase Storage uses it as its S3 backend, so synced PDFs live here.                                                       |
| `presio-db-init` | One-shot job that applies the repo's `dbschema.sql` (the `sessions` table + `presentations` bucket) once auth and storage are ready.                              |

Only `presio` and `kong` are exposed (via Traefik labels + the `web` network);
everything else stays on the internal network. Almost no app code is
Supabase-specific — it's reached only via env-configured URLs/keys — so
self-hosting is mostly configuration.

## Files

```text
docker-compose.yml        # the whole stack — run `docker compose up` from the repo root
deploy/
  Dockerfile              # builds the presio app image
  .env.example            # every stack setting; copy to ./.env (repo root) and fill in
  volumes/                # vendored Supabase config (kong, db init, etc.), pinned
    UPSTREAM_PINNED_SHA.txt  # the supabase/supabase commit these files come from
proxy/
  docker-compose.yml      # the shared Traefik proxy (run once per host)
  README.md               # the TLS story: Cloudflare Origin CA, and why no ACME
  certs/dynamic/          # file-provider config: certificates + the cfonly allowlist
dbschema.sql              # mounted into presio-db-init
```

## Prerequisites

- A Linux host with Docker + Docker Compose, ports **80 and 443** open.
- Two DNS `A`/`AAAA` records pointing at the host, e.g. `presio.xyz` (app) and
  `supabase.presio.xyz` (Supabase API), resolving publicly.
- A TLS certificate for those names. The presio.xyz deployment sits behind
  Cloudflare and uses a Cloudflare Origin CA certificate, because an origin
  that only admits Cloudflare cannot complete an ACME challenge — see
  [`proxy/README.md`](../proxy/README.md). Self-hosting without a CDN in
  front, add an ACME resolver to `proxy/docker-compose.yml` instead; Traefik's
  TLS-ALPN-01 challenge needs nothing but port 443.

## 1. Generate secrets

The Supabase secrets (`JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`) must be a
matching set. Generate them with Supabase's helper:
<https://supabase.com/docs/guides/self-hosting/docker#generate-api-keys>
(or `sh utils/generate-keys.sh` from a checkout of `supabase/supabase`).

## 2. Configure the stack `.env`

Copy the example to a `.env` **at the repo root** (this is where
`docker compose` reads it from when you run it from the root):

```bash
cp deploy/.env.example .env
# edit .env — domains, the generated secrets, MinIO + dashboard passwords,
# and the GitHub OAuth client id/secret.
```

Set the domains to your **real, externally-resolvable** values:

- `APP_HOST` / `SUPABASE_HOST` → bare hostnames, e.g. `presio.xyz` /
  `supabase.presio.xyz` (these drive Traefik's `Host()` routing rules).
- `APP_HOST_ALT` / `SUPABASE_HOST_ALT` → optional second hostnames; leave empty
  for a single domain. See [Serving the app on two
  domains](#serving-the-app-on-two-domains).
- `PUBLIC_BASE_URLS` → comma-separated public origins, in priority order.
  Share and handoff links follow whichever listed domain the visitor used;
  canonical/og:url and the OpenAPI and schema self-references always name the
  first. Defaults to `https://${APP_HOST}`.
- `SITE_URL` → `https://presio.xyz`
- `SUPABASE_PUBLIC_URL` / `API_EXTERNAL_URL` → `https://supabase.presio.xyz`

> **Why the public URL matters:** the Presio server uses `SUPABASE_PUBLIC_URL`
> both to call Supabase and to build the public PDF URLs it hands to viewers, so
> it has to be reachable from outside the stack.

## 3. GitHub OAuth

Create a GitHub OAuth App (Settings → Developer settings → OAuth Apps):

- **Authorization callback URL:** `https://supabase.presio.xyz/auth/v1/callback`
  (i.e. `${API_EXTERNAL_URL}/auth/v1/callback`).

Put its client id/secret into `GITHUB_CLIENT_ID` / `GITHUB_SECRET` in `.env`.
Email/password is enabled too (`ENABLE_EMAIL_SIGNUP=true`, auto-confirm on by
default — set `ENABLE_EMAIL_AUTOCONFIRM=false` and fill `SMTP_*` for real
verification emails).

## 4. Start the shared proxy (once per host)

```bash
docker network create web        # the shared ingress network
cd proxy
docker compose up -d
```

Traefik now owns ports 80/443 and watches Docker for labelled containers. You
only do this once — every app (including Presio) attaches to the `web` network.

The proxy serves TLS from certificates on disk under `proxy/certs/`, which are
**not** in version control — install yours there and point
`certs/dynamic/default.yml` at them. [`proxy/README.md`](../proxy/README.md)
covers how those are minted and why this deployment runs no ACME resolver.

## 5. Start Presio

From the **repo root**:

```bash
APP_VERSION=$(git describe --tags --always) docker compose up -d --build
docker compose ps                # everything healthy / completed
```

`APP_VERSION` is optional but worth passing: it is what `/healthz` reports back,
so you can confirm the build you meant to deploy is the one running. Left unset
it is `dev`, and a half-applied deploy looks exactly like a good one.

First boot runs the Supabase migrations, creates the MinIO bucket, then
`presio-db-init` applies `dbschema.sql`, then `presio` starts. Once DNS
resolves, Traefik serves:

- `https://presio.xyz` → the app
- `https://supabase.presio.xyz` → Supabase API + Studio (login
  `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD`)

Watch certificate issuance / routing with `docker compose -p proxy logs -f traefik`.

## What sits in front of the app (production)

Two hops, and the count matters — it is what `trust proxy` is set to:

```
visitor ──▶ Cloudflare edge ──▶ Traefik ──▶ presio:3001
                                └── app.set("trust proxy", 1) counts from here
```

Traefik runs without `forwardedHeaders.trustedIPs`, so it **overwrites**
`X-Forwarded-For` with its own peer rather than appending to Cloudflare's. The
app therefore sees the Cloudflare edge as `req.ip`, and raising the hop count
would not change that — the visitor's real address survives only in
`Cf-Connecting-Ip`. `trust proxy` is kept for `req.protocol`, which `baseUrl()`
needs so generated links come out `https://`.

### Serving the app on two domains

Every public router takes an optional second hostname via an `_ALT` variable —
`APP_HOST_ALT`, `SUPABASE_HOST_ALT`. What
each one is *for* differs, and the table below spells that out.

The rule is two matchers OR'd together, **not** ``Host(`a`, `b`)`` — the
multi-value form is Traefik v2 syntax. Traefik v3 rejects it with *"unexpected
number of parameters; got 2, expected one of [1]"* and **disables the router**,
which takes the app offline rather than failing visibly at deploy time:

```
traefik.http.routers.presio.rule=Host(`${APP_HOST}`) || Host(`${APP_HOST_ALT:-${APP_HOST}}`)
```

Only the *app* is genuinely served from two domains at once. `VITE_SUPABASE_URL`
is baked into the client bundle at build time, `API_EXTERNAL_URL` is what GoTrue
builds OAuth redirects and email links from, and an OAuth app has one callback
URL — so the API, auth and storage have a single canonical domain. Put it on
whichever domain is reachable from the most restricted network you care about.

Every router nevertheless takes an `_ALT` hostname, because a *move* is not the
same thing as being dual-homed: the second matcher keeps the **previous**
hostname answering while clients still hold it.

| Router | Primary | Second matcher | What the second one is for |
| --- | --- | --- | --- |
| app | `APP_HOST` | `APP_HOST_ALT` | genuinely serving both domains |
| Supabase (Kong) | `SUPABASE_HOST` | `SUPABASE_HOST_ALT` | a cached service worker or installed PWA still calling the old API host |

Both default back to their primary when the `_ALT` is empty, so a
single-domain deployment needs no change.

The analytics one is the easy one to get wrong. `ANALYTICS_URL` has to name the
same host `client/index.html` loads the tracking script from — the CSP
`script-src` is derived from it, so a mismatch blocks analytics with no error
anyone will notice. And because the built client is service-worker precached,
an analytics hostname must keep answering after a move, or the hits from every
visitor still running a pre-move bundle are silently dropped for as long as
that cache lives.

### Analytics and uptime monitoring live outside this stack

Umami and Uptime Kuma are shared by every app on the host, so they run in a
stack of their own next to the proxy (`~/ops` on the presio host), with
Umami's own Postgres. Traefik routes **every** `analytics.*` hostname to Umami
and every `uptime.*` hostname to Kuma, so all of `analytics.presio.xyz`,
`analytics.presio.ch` and any later domain answer without per-app config —
which also covers the hostname-move problem above. This stack only carries
`ANALYTICS_URL`. (Until 2026-09-30 both were services here, with Umami's data
in this stack's Postgres.)

Because `VITE_SUPABASE_URL` is a **build arg**, changing it needs
`docker compose up -d --build`. A plain restart keeps the old bundle.

#### `www.` is handled at the edge, not here

The app router deliberately matches the apex only. `www.` is not added to the
`Host()` rule — that would serve the same app under four names and put the
duplicate-content problem back. Each zone instead carries a Cloudflare
dynamic-redirect rule in the `http_request_dynamic_redirect` phase:

```
expression: http.host eq "www.presio.ch"
action:     redirect, 301, preserve_query_string
target:     concat("https://presio.ch", http.request.uri.path)
```

One per zone, each pointing at **its own** apex — `www.presio.xyz` goes to
`presio.xyz`, not to the canonical `presio.ch`. Sending it across would drop the
visitor on a different origin, and the two domains share no browser storage, so
their local decks, recents list, controller layout and auth session would all
appear to have vanished. Canonical tags are what consolidate the two domains for
search engines; redirects are not the tool for it.

Note this is per zone, like the rate-limit rules below: a domain added later
without its own rule simply has no `www` redirect.

Both Traefik entrypoints refuse any source outside Cloudflare's published
ranges (`proxy/certs/dynamic/cfonly.yml`, applied as an entrypoint-default
middleware so every router is covered), and the host firewall is configured to
the same effect. That is what makes `Cf-Connecting-Ip` trustworthy at the edge:
it is an ordinary header, so it is only meaningful while the edge is
unavoidable.

### A separate origin for viewers

Audiences can watch on their own hostname, e.g. `viewer.presio.ch` beside
`presio.ch`. The presenter's plugins run on every audience device; on the
viewer origin they can't reach what Presio keeps in an audience member's
browser for the app origin — their login, the controller tokens of their own
decks. With it unset, viewers use the app hostnames as before (self-hosting,
local mode).

1. Add a DNS record per viewer hostname, pointing where the app's does
   (proxied through Cloudflare). Keep each one level under the domain —
   `viewer.presio.ch`, `staging-viewer.presio.xyz` — so the `*.domain`
   origin certificates already cover it.
2. Set `VIEWER_HOST` (and `VIEWER_HOST_ALT` when dual-homed; they pair with
   `APP_HOST` / `APP_HOST_ALT` in order) in the stack `.env`, and add their
   `https://` origins to `ALLOWED_ORIGIN` — `gen-env.sh` does both from
   `VIEWER_DOMAIN` / `VIEWER_DOMAIN_ALT`. Staging takes `STAGING_VIEWER_HOST`
   (and `_ALT`).
3. Redeploy. Join links and QR codes now point at the viewer host; old viewer
   links on the app host redirect there, and "Switch to Controller" hands back
   to the app host to ask for the passphrase.

The isolation relies on Presio keeping auth out of domain-wide cookies — a
subdomain shares those. Its auth lives in localStorage and request headers.

## Monitoring certificate expiry

Uptime Kuma runs host-wide (see above), on the shared `web` network, so it
reaches `presio-cert-expiry` by name. Two monitors are worth having:

| Monitor | Type | Target |
| --- | --- | --- |
| App reachable | HTTP(s) | `https://${APP_HOST}/healthz` |
| Origin certificates | HTTP(s) - Keyword | `http://presio-cert-expiry:8080/cgi-bin/check`, keyword `cert-expiry: OK` |

The second exists because the first cannot cover it. Behind a CDN, a monitor on
the public URL validates the **edge** certificate, which the CDN renews on its
own schedule — it stays green while the origin behind it serves something
expired. The `cert-expiry` service asks Traefik directly, over the internal
network, for each hostname in turn, so it reports what a real handshake gets.

That is not hypothetical: presio.xyz served expired certificates for two days
in September 2026 while every public check passed, because the zone was on SSL
mode `full`, which does not verify the origin at all. Run the zones on **Full
(strict)** and keep this monitor — the first makes a bad origin certificate
fail, the second tells you before it does.

Run it by hand any time:

```bash
docker compose exec cert-expiry /srv/check.sh
```

Tune the warning window with `CERT_EXPIRY_MIN_DAYS` (default 30) and the
hostname list with `CERT_EXPIRY_HOSTS`, both on the `cert-expiry` service.

## Rate limiting

The app does **no HTTP rate limiting of its own** — that belongs on whatever
proxy or CDN fronts it, which is the only layer that can see the real client
address. Behind two hops (a CDN, then Traefik) the address the app observes is
the CDN's edge, so a limiter here would put every visitor behind a given edge
into one shared bucket; the real address arrives only in a vendor header such
as `Cf-Connecting-Ip`, which is forgeable by anyone able to reach the origin
directly. presio.xyz limits at the Cloudflare edge and refuses non-Cloudflare
traffic at the origin. If you self-host without a CDN in front, add a limit on
your own proxy — Traefik's own `ratelimit` middleware is enough.

Cloudflare rate-limit rules are **per zone**. Serving the app from two domains
means two zones and therefore two independent buckets: a client gets the full
allowance on each, so the effective ceiling is doubled. Recreate the rules on
every zone — a domain without them is the soft way in to the same origin.

Independent of this, `join_session` over Socket.IO is throttled per connection
in `server/socket/guards.ts`, because its reply reveals whether a 6-character join code
exists. That throttle is part of the app and needs no configuration.

## Versions and upgrading

Releases are `v*` git tags, published as container tags on
`ghcr.io/benedict-armstrong/presio-local`:

| Tag | Moves when | Use it for |
| --- | --- | --- |
| `:1` | any 1.x release | **Production.** Fixes and features, no breaking changes. |
| `:1.2` | any 1.2.x patch | Production, if you'd rather adopt minor releases deliberately. |
| `:1.2.3` | never | Reproducible deploys; you upgrade by editing the tag. |
| `:latest` | any release | Trying it out; the newest release regardless of major. |
| `:main` | every merge to `main` | Testing unreleased work. **Not for production** — no upgrade guarantees. |
| `:sha-<short>` | never | Pinning one exact build. |

Every published image carries a signed build provenance attestation and an
SBOM. Verify a build really came from this repository with:

```bash
docker buildx imagetools inspect ghcr.io/benedict-armstrong/presio-local:1 \
  --format '{{ json .Provenance }}'   # how and from what commit it was built
docker buildx imagetools inspect ghcr.io/benedict-armstrong/presio-local:1 \
  --format '{{ json .SBOM }}'         # what is inside it

# Releases from v1.2.0 onward also carry a Sigstore-signed attestation in
# GitHub's own store, which the CLI checks against this repository:
gh attestation verify --repo benedict-armstrong/presio \
  oci://ghcr.io/benedict-armstrong/presio-local:1
```

### Upgrading

Data migrates **forward only**. Local mode's SQLite schema is versioned
(`PRAGMA user_version`, see `server/local/db.ts`) and the container applies any
outstanding migrations on start, copying the database to
`presio.db.bak-v<n>` in the data directory first. Starting an **older** image
against a newer data directory is refused rather than attempted, so roll
forward, don't roll back.

```bash
docker compose -f local.docker-compose.yml pull
docker compose -f local.docker-compose.yml up -d
docker compose -f local.docker-compose.yml logs presio | grep '\[local\]'
curl -fsS http://localhost:3001/healthz     # {"status":"ok", ..., "version":"1.2.3"}
```

Each release is tested for exactly this: CI boots the current release against a
data volume, writes a session, then boots the new build on the same volume and
reads it back.

### Backups

Everything local mode owns lives under `LOCAL_DATA_DIR` — the SQLite database
and the uploaded PDFs. One volume is the whole backup:

```bash
docker run --rm -v presio-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/presio-data.tgz -C /data .
```

Restore by stopping the container and untarring back into the volume. For the
full self-hosted stack, the equivalent state is Postgres (`docker compose exec
db pg_dump`) plus the MinIO volume — the `presio` container itself is
stateless.

### Reporting a problem

Include the output of `/healthz` (it reports the running version) and, for
local mode, the `[local]` lines from the container log.

## Adding more apps to the same host

You do **not** add a second proxy. Give the new app's container a route on the
same proxy:

1. Attach its service to the external `web` network.
2. Add Traefik labels (swap the names/host/port):

   ```yaml
   networks: [default, web]
   labels:
     - "traefik.enable=true"
     - "traefik.docker.network=web"
     - "traefik.http.routers.myapp.rule=Host(`app2.example.com`)"
     - "traefik.http.routers.myapp.entrypoints=websecure"
     - "traefik.http.routers.myapp.tls=true"
     - "traefik.http.services.myapp.loadbalancer.server.port=8080"
   ```

3. Point `app2.example.com` at the host and `docker compose up -d`. TLS is
   served from the proxy's **default** certificate (a Cloudflare Origin CA cert
   covering `presio.xyz` + `*.presio.xyz`), so keep the hostname one level
   deep under `presio.xyz` — that's what Cloudflare's edge certificate and
   the origin cert both cover. No per-host ACME is involved, and none can be:
   the origin admits Cloudflare only, so no ACME challenge reaches it. See
   [`proxy/README.md`](../proxy/README.md).

   For a hostname under a *different* domain, the default certificate won't
   cover it. Add a second certificate rather than replacing the default —
   Traefik picks per-handshake by SNI, so the existing domain is unaffected:

   ```yaml
   # proxy/certs/dynamic/presio-ch.yml
   tls:
     certificates:
       - certFile: /certs/presio.ch.pem
         keyFile: /certs/presio.ch.key
   ```

   Generate the key **on the host** and send only the CSR out for signing, so
   the private key never travels:

   ```bash
   openssl req -new -newkey rsa:2048 -nodes \
     -keyout presio.ch.key -out presio.ch.csr \
     -subj "/CN=presio.ch" \
     -addext "subjectAltName=DNS:presio.ch,DNS:*.presio.ch"
   ```

   Sign the CSR as a Cloudflare Origin CA certificate (dashboard, or
   `POST /certificates` with `request_type=origin-rsa`), install the returned
   cert next to the key, and set that zone's SSL mode to **Full (strict)** —
   the API value is `strict`, not `full_strict`. Traefik's file provider picks
   the new file up live; no restart.

   Check what the origin actually serves, per hostname, rather than trusting
   the config — an SSL mode of plain `full` does not verify the origin, so a
   wrong or expired certificate there stays invisible from the outside:

   ```bash
   echo | openssl s_client -connect 127.0.0.1:443 -servername app2.example.com \
     2>/dev/null | openssl x509 -noout -issuer -dates -ext subjectAltName
   ```

## Continuous deployment (optional)

`.github/workflows/ci.yml` runs build/typecheck/compose-validate checks on every
push. There's no push-button deploy anymore (we dropped the Coolify API hook); to
auto-deploy on the host, add a step that SSHes in and runs
`git pull && docker compose up -d --build`, or use a tool like
[watchtower](https://containrrr.dev/watchtower/) / a webhook on the host.

## Updating the pinned Supabase version

The vendored files come from the `supabase/supabase` commit recorded in
`deploy/volumes/UPSTREAM_PINNED_SHA.txt`. To bump: re-fetch
`docker/docker-compose.yml`, `docker/docker-compose.s3.yml`, and
`docker/volumes/**` at the new commit, then re-apply the local adaptations (S3
backend on `storage`; the `minio` / `minio-createbucket` / `presio-db-init` /
`presio` services; the Traefik labels + `web` network on `presio`/`kong`; and the
uncommented GitHub provider lines in `auth`).

## Trimming unused services

Presio itself only needs `db`, `kong`, `auth`, `rest`, `storage`, `imgproxy`,
plus `minio`. `realtime`, `functions` (edge), and `supavisor` (pooler) are not
used (Presio runs its own Socket.IO and talks to Kong, not Postgres directly).
They're kept so the upstream stack boots exactly as shipped; you can disable them
to save resources, but leave `studio`/`meta` (Kong's health gate depends on
`studio`).

## Running fully local / offline

If you just want to present PDFs on your own machine or LAN — no public
domain, no accounts, no analytics — none of the above is needed at all. A
**single prebuilt container** (`linux/amd64` and `linux/arm64`), no Supabase,
no `.env`, no checkout:

```bash
docker run -d --name presio -p 3001:3001 \
  -e PRESIO_MODE=local -e LOCAL_DATA_DIR=/data -e TRUST_PROXY=false \
  -v presio-data:/data \
  ghcr.io/benedict-armstrong/presio-local:1
open http://localhost:3001
```

Or with Compose, which sets all of that for you:

```bash
curl -fsSLO https://raw.githubusercontent.com/benedict-armstrong/presio/main/local.docker-compose.yml
docker compose -f local.docker-compose.yml up -d
```

The image is published by `.github/workflows/publish-local-image.yml`; see
[Versions and upgrading](#versions-and-upgrading) for which tag to run. From a
checkout, `docker compose -f local.docker-compose.yml build` builds the same
image from source instead.

Set `PRESIO_MODE=local` and the server swaps Supabase for a bundled SQLite
database and filesystem storage under `/data` (see `server/local/`) instead of
Postgres/GoTrue/Storage/Kong. Login and cross-device sync-by-account aren't
available in this mode (there's no auth provider to back them), but everything
else works: local presentations, handoff links, and controller/viewer sync
over Socket.IO. CORS accepts any origin in this mode since there's no fixed
domain to allow ahead of time, and PDF links are relative, so they resolve
correctly whichever address the page was opened at.

### Joining from other devices

Viewers on the same network join by scanning the QR code on the share screen.
Presio works out this machine's LAN address itself, so on a local install
there's usually nothing to configure — but it can only do that when it can see
the host's network, and a container on Docker's default bridge network can't:
every address it can see belongs to the container. In that case set
`PRESIO_PUBLIC_HOST` to the address other devices reach this machine on, read
at run time so it needs no rebuild:

```bash
docker run -d --name presio -p 3001:3001 \
  -e PRESIO_MODE=local -e LOCAL_DATA_DIR=/data -e TRUST_PROXY=false \
  -e PRESIO_PUBLIC_HOST=192.168.1.20:3001 \
  -v presio-data:/data \
  ghcr.io/benedict-armstrong/presio-local:1
```

On Linux, `--network host` works instead and needs no address at all — but not
on Docker Desktop, where the "host" is a Linux VM rather than your machine.
Without either, the share screen asks for the address once and remembers it.

To find the address, run this **on the host machine**, not inside the
container — it's the one on the network your phone or laptop is on, usually
starting `192.168.`, `10.` or `172.`:

| OS | Command |
| --- | --- |
| macOS | `ipconfig getifaddr en0` (Wi-Fi; try `en1` if that's empty), or System Settings › Network |
| Windows | `ipconfig`, then the `IPv4 Address` of the connected adapter |
| Linux | `hostname -I` (the first address), or `ip route get 1.1.1.1` and read `src` |

Append the port Presio is served on (`3001` above). Opening
`http://<that-address>:3001` on the other device directly works too. If it
doesn't connect, check that both devices are on the same network — guest Wi-Fi
and client isolation block it regardless of the address — and that the host
firewall allows the port.
