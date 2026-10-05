# Deployment

The web app runs on Vercel. The API runs as a Docker container on a container host, with managed Postgres, Redis and an S3 bucket. GitHub Actions deploys only after CI passes, and every production deploy waits for your approval.

```
push / merge to main
   │
   ▼
CI ─ type-check, unit + screen tests, build, production-settings check
   ─ end to end on Postgres: migrations (twice), bootstrap on an empty database, 18-step demo,
     pitch demo, all end-to-end suites, invite email over real SMTP
   │ passes
   ▼
Deploy (approve "production") ─ 1 migrations as vat_owner
                               ─ 2 API image → GitHub registry → host deploy hook → wait until /health reports this commit
                               ─ 3 web: vercel pull / build / deploy --prebuilt → smoke test
Phone app ─ EAS build (manual for now), pointing at https://api.nex-gen.africa
```

**Why the API is not on Vercel.** It runs background jobs (document reading, reminders every 15 minutes), it verifies Stripe, MIPS and Twilio webhooks against their exact raw bytes, and it holds database connections. That needs an always-on container. Vercel serves the Next.js web app, which is what it is built for.

## Services to set up

| Service | For | Notes |
|---|---|---|
| Vercel (Pro) | Web app at `app.nex-gen.africa` | The Hobby plan is for non-commercial use |
| Container host | API at `api.nex-gen.africa` | For example Render, Railway, Fly.io or DigitalOcean App Platform. It must run an image from GitHub's registry, hold secrets, check `/health` and offer a deploy hook |
| Postgres 16 (managed) | All data | Daily backups plus point-in-time recovery; test a restore before the pilot |
| Redis (managed, TLS) | Background jobs | A standard Redis that BullMQ supports |
| AWS S3 bucket | Documents | Needs presigned POST uploads, which AWS S3 supports. `af-south-1` is the closest region |
| Twilio | Sign-in codes (Verify), SMS reminders | WhatsApp later, after Meta approves the templates |
| Anthropic API | Reading invoices | |
| cPanel mailbox `connect@nex-gen.africa` | Staff invites | See "Email for staff invites" in `DEVELOPMENT.md` |
| Stripe / MIPS | Card payments | Later, when merchant accounts exist. Juice and bank transfers work without them |

## 1. Database

Run as the database administrator, with passwords from your password manager:

```sql
create role vat_owner login password '<strong password>';
create role vat_app login password '<strong password>' nobypassrls;
create database vat_assist;
alter database vat_assist owner to vat_owner;  -- lets migrations create pgcrypto, citext and btree_gist
```

- **Non-superuser admins:** where the administrator is not a superuser (AWS RDS, for example), run `grant vat_owner to <admin user>;` first, so it can hand over ownership.
- **Connections:** use `sslmode=require` on both connection strings.
- **Who connects:** `vat_owner` runs migrations; the API connects as `vat_app`, which cannot bypass row-level security.
- **Where migrations run:** the Deploy workflow runs them from GitHub's runners, so the database must accept those connections. If it can't, run `node packages/api/dist/scripts/migrate.js` as the host's release command instead.

## 2. Storage bucket

- Block all public access, and give the API's access key permissions for this bucket only.
- Keep objects at least 6 years (retention policy).
- Allow the pay page to upload transfer screenshots:

```json
[{ "AllowedOrigins": ["https://app.nex-gen.africa"], "AllowedMethods": ["POST", "GET"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 3000 }]
```

## 3. Production settings

1. Copy `.env.production.example` to `.env.production` (never commit it) and fill everything in `<angle brackets>`.
2. Check it: `npm run config:check -- ../../.env.production`. It must print `OK`. It catches missing settings, bad values, placeholders, provider gaps and production rules (https, no development providers, a real sender).
3. Paste the values into the API host's secret settings.

## 4. API host

- **Image:** `ghcr.io/<owner>/<repo>/api:latest`. The package is private, so give the host a registry credential (a GitHub token with `read:packages`).
- **Service:** port 4000, health check path `/health`. Start with one instance, because rate limits are per process (decision 17); about 1 GB of memory leaves room for image processing.
- **Releases:** copy the host's deploy hook URL into GitHub as `API_DEPLOY_HOOK_URL`.
- **Domain:** point `api.nex-gen.africa` at the host, adding the DNS record where `nex-gen.africa`'s DNS is managed (cPanel Zone Editor if it is there).
- **Webhooks to register:**
  - Twilio inbound messages: `https://api.nex-gen.africa/webhooks/twilio/inbound` (STOP / ARRET opt-outs).
  - Stripe: `https://api.nex-gen.africa/webhooks/stripe`.
  - MIPS IMN: `https://api.nex-gen.africa/webhooks/mips/<MIPS_IMN_PATH_SECRET>`.
  - Delivery-status callbacks are set by the API itself.

## 5. Web app on Vercel

1. From the repository root, run `npx vercel link` and create the project. Don't connect the Git repository: only the Deploy workflow should deploy, after CI passes.
2. Project settings → Build and Deployment:
   - Root Directory `apps/web`, framework Next.js, Node.js 22.x.
   - `apps/web/vercel.json` already sets the monorepo install and build commands.
3. Environment variables (Production): `API_URL=https://api.nex-gen.africa`.
4. Domains: add `app.nex-gen.africa` and create the DNS record Vercel shows.
5. Copy `orgId` and `projectId` from `.vercel/project.json` into GitHub as `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`, and create a token for `VERCEL_TOKEN`.

The workflow follows Vercel's documented CLI path: `vercel pull`, `vercel build --prod`, `vercel deploy --prebuilt --prod`. What CI built is exactly what goes live.

## 6. GitHub

- **Environment:** Settings → Environments → `production`, with yourself as required reviewer, so every production deploy waits for your approval.
- **Environment secrets:** `DATABASE_OWNER_URL`, `API_DEPLOY_HOOK_URL`, `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`.
- **Environment variables:** `API_BASE_URL=https://api.nex-gen.africa`, `WEB_BASE_URL=https://app.nex-gen.africa`.
- **Branch protection on `main`:** require both CI jobs.
- **Dependabot** opens weekly update pull requests; each one runs the full CI.

## 7. First deploy

1. Database, Redis, bucket, Twilio and Anthropic ready; DNS records for `app.` and `api.` created.
2. `.env.production` passes `config:check`; values loaded into the API host; Vercel settings done.
3. Run **Actions → Deploy → Run workflow** (or merge to `main`) and approve `production`: migrations, then the API, then the web app.
4. **Create the platform and the first admin**, once, from your own terminal (the link must not end up in CI logs):

```
docker run --rm --env-file .env.production ghcr.io/<owner>/<repo>/api:latest \
  node packages/api/dist/scripts/bootstrap.js --platform-name "Nex-Gen Africa Ltd" \
  --admin-email connect@nex-gen.africa --admin-name "<your name>" --email \
  --juice-mobile <+2305...> --bank-name MCB --bank-account-name "Nex-Gen Africa Ltd" --bank-account-number "<account>"
```

   Open the emailed link, set a password and an authenticator, and keep the recovery codes. The Juice and bank details are how shops pay Nex-Gen's booking deposit.
5. In Admin → Staff, send a test email to yourself, then invite the reviewers.
6. **Smoke test:**
   - `https://api.nex-gen.africa/health` shows the deployed commit;
   - staff sign-in works;
   - a real phone number receives a sign-in code;
   - a photographed invoice is read;
   - the VAT Pot shows;
   - reminders go out at 09:00 Mauritius time on the day before a deadline.

## Updates and rollback

- **Every merge to `main`:** CI, then Deploy with your approval, then migrations, the API and the web app.
- **Migrations must not break the API version still running:** add columns and tables first, remove them in a later release ("expand, then contract"). They are checksummed and run once.
- **Rolling back the API:** redeploy the previous image; each image is tagged with its commit.
- **Rolling back the web app:** `vercel rollback`, or promote the previous deployment in Vercel.
- **The database is forward-only:** restore from backup only after data loss.

## Phone app

- **Build:** `npx eas build -p android --profile production` (and `-p ios`), with `EXPO_PUBLIC_API_URL=https://api.nex-gen.africa`.
- **Pilot distribution:** Google Play internal testing and TestFlight are enough.
- **Store releases:** come later, and are not automated yet.
