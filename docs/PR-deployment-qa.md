# PR: Deployment, CI/CD, pilot scorecard and the pitch demo

## Summary

VAT Assist is now deployable and measurable.

- **CI and deploys:** CI runs every check on each pull request. After CI passes on `main`, and after your approval, the deploy workflow runs migrations, releases the API image and deploys the web app to Vercel.
- **Settings and bootstrap:** production settings are templated and checked, and a bootstrap creates the first admin in a new environment.
- **Pilot:** the 10-shop pilot has a live scorecard against its targets.
- **Demo:** the pitch demo runs in presentation order and checks itself.

## Changes

- **CI** (`.github/workflows/ci.yml`):
  - type-check, unit and screen tests, build, and the production-settings template check;
  - end to end on Postgres: migrations run twice, bootstrap on an empty database, the 18-step demo, the pitch demo, all end-to-end suites, and the invite over real SMTP with `connect@nex-gen.africa` settings.
- **Deploy** (`.github/workflows/deploy.yml`):
  - after CI on `main`, or by hand, behind the `production` environment;
  - migrations, then the API image to GitHub's registry and the host's deploy hook, waiting until `/health` reports the new commit;
  - then Vercel `pull` / `build --prod` / `deploy --prebuilt --prod`, then a smoke test.
- **Build files:**
  - `packages/api/Dockerfile` (multi-stage, non-root, health check, commit stamped);
  - `.dockerignore`;
  - `apps/web/vercel.json` (monorepo install and build);
  - security headers on the web app;
  - Dependabot and a PR template.
- **Settings:**
  - `.env.production.example`: all 79 settings, using `connect@nex-gen.africa` for email, with secrets left to fill;
  - `npm run config:check` checks missing settings, invalid values, placeholders, provider gaps, production rules and typos.
- **`npm run bootstrap`:** creates the platform organisation and invites the first admin (link printed or emailed), optionally with Nex-Gen's Juice and bank details. It refuses once an admin exists.
- **Pilot:**
  - migration 0015 adds referral codes, the cohort tag, and an admin-only data function;
  - the metric rules live in `pilot-metrics.ts`;
  - **Admin → Pilot** has the scorecard, the per-shop table and cohort tagging;
  - referral codes appear at sign-up, in phone Settings and on the owner web page, and are accepted in any case.
- **Demo:** `npm run demo:pitch` in your order, reading the real SMS from the new development message outbox. `docs/DEMO-SCRIPT.md` is the talk track.
- **Docs:** `docs/DEPLOYMENT.md`, `docs/PILOT.md`, `docs/DEMO-SCRIPT.md`, `DEVELOPMENT.md`, and decisions 19 and 23–27.

## Verified here

- `actionlint` 1.7.8 passes both workflows; `hadolint` passes the Dockerfile.
- The settings template passes `config:check`.
- Unit tests, web and phone screen tests, and the 18-step and pitch demos pass.
- The end-to-end suites pass, including the pilot suite and the SMTP suite.
- The bootstrap is proven on an empty database: create, re-run, accept the invite, sign in as admin, refuse a third run.

## Not verified here

- GitHub Actions itself, Vercel, the container host and Docker builds: no accounts, and no Docker in this sandbox.
- The first real run of the workflows is the check.
