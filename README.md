# AFICIONADOS STATE

Public website MVP for the Aficionados State creative movement. The app uses Node.js built-ins and does not require npm runtime dependencies.

## Deploy with Docker Compose

Requires Docker Engine with the Compose plugin.

```sh
cp .env.example .env

docker compose up --build -d
docker compose ps
```

The app listens on port `3000` inside the container. The host port is controlled by `PORT` in `.env`. Put it behind a TLS terminating reverse proxy or managed HTTPS platform. Configure that proxy to pass requests to port 3000 and to overwrite forwarded client IP headers. The included container runs as the unprivileged `node` user, has a read-only root filesystem, drops Linux capabilities, and stores form data in the persistent `inquiry-data` volume.

Check health with `docker compose ps` or request `/healthz`. To update the deployment, run `docker compose up --build -d`. To stop it, run `docker compose down`; the named data volume remains. To remove saved inquiry data too, explicitly run `docker compose down --volumes` after making any required backup.

Set `TRUST_PROXY=true` only when the app is reachable exclusively through a trusted proxy that replaces `X-Forwarded-For`. Leave it false for direct access. Incorrect proxy trust can let visitors spoof their address and evade rate limits.

## Deploy to Vercel

The repository includes Vercel routing for the static pages and serverless form endpoints. Connect the repository to a Vercel project and add an Upstash Redis database through the Vercel Marketplace. The integration must provide `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` to Production and Preview environments. Vercel functions use ephemeral filesystems, so submissions use Redis there; local development and Docker deployments can continue to use the JSON store. Do not deploy without persistent storage configured, because submissions will return `503` instead of being written to temporary storage.

Set `SITE_URL` to the production HTTPS domain when one is configured. Vercel Hobby is limited to personal, non-commercial use; use a plan that permits this organization's commercial website. Existing local JSON records are not automatically copied to the cloud database.

## Run locally

Requires Node.js 20 or later.

```sh
npm start
```

Open `http://localhost:3000`. The server binds to loopback for local development and to `0.0.0.0` when `NODE_ENV=production`; `HOST` can override this. Set `PORT` to change the listener port, `DATA_DIR` to choose the private inquiry storage directory, and `SITE_URL` to configure absolute sitemap URLs. Without `SITE_URL`, the sitemap uses the request origin. Do not expose `DATA_DIR` through the web server.

## Included

- Responsive pages for Home, About, Pillars, Team, Portfolio, Experiences, Opportunities, Community, Services, Partnerships, Events, Shop, Contact and Journal.
- Working contact, business inquiry, partnership inquiry and opt-in newsletter endpoints with input validation, cleanup, honeypot and request size limit; Vercel deployments use Redis-backed per-IP rate limiting.
- Persistent JSON inquiry storage via a Docker named volume. Newsletter duplicate addresses are ignored.
- Sitemap, robots, canonical and Open Graph metadata, health endpoint, security headers, graceful SIGTERM/SIGINT handling.
- No fictional team profiles, public opportunities, events, campaigns, statistics, testimonials, payment confirmations or merchandise benefits.

## Not included

This is a deployable public website MVP, not the complete platform in the master brief. It has no production database, authentication, member accounts, admin CMS, RBAC, audit log, file uploads, opportunity applications, event registration, notifications, payment/order management, team operations, financial records, analytics integration, localization, or automated backups. Opportunities, events, portfolio projects and team biographies remain unpublished until verified content is provided.

The local JSON store and in-process rate limiter are designed for a single app instance. Vercel uses Upstash Redis for persistent submissions and distributed rate limiting. There is no admin UI to view or manage submissions; operators need controlled provider access until the secured admin phase exists. Before relying on the site for high-volume or sensitive production workflows, build authenticated admin access and retention/deletion controls, configure encrypted backups and monitoring, and verify the deployed proxy/TLS setup. Keep local data stores private and back them up securely.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listener port (container internal port remains 3000 in Compose) |
| `HOST` | loopback locally; `0.0.0.0` in production | Network interface to bind |
| `DATA_DIR` | `./data` | Private directory for inquiry JSON records |
| `SITE_URL` | request origin | Public site origin for sitemap and robots output; use the HTTPS origin in production |
| `TRUST_PROXY` | `false` | Trust the first `X-Forwarded-For` address only behind a trusted proxy |
| `UPSTASH_REDIS_REST_URL` | unset | HTTPS REST endpoint for persistent Vercel submission storage and distributed rate limiting |
| `UPSTASH_REDIS_REST_TOKEN` | unset | Secret token for the Upstash Redis REST endpoint |

Local and Docker deployments need no third-party service credentials. Vercel deployments require the Upstash Redis REST credentials listed above.

## Verification

```sh
npm run check
npm test
```

Tests cover route handling, headers, health response, form validation and persistence, newsletter consent/deduplication, and SEO endpoint origin. UI automation and authorization tests remain pending because those application areas are not implemented.
# AFFICIANADO
# Aficianados-state
