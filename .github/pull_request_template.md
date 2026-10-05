## What and why

## Checklist
- [ ] `npm run typecheck` and `npm test` pass locally
- [ ] New or changed behaviour has tests (unit, screen or end to end)
- [ ] Database changes are a new migration (never an edit), and safe while the previous API version still runs
- [ ] New settings are in `.env.example` and `.env.production.example` (`npm run config:check -- ../../.env.production.example --template`)
- [ ] User-facing text exists in English, French and Kreol, or is flagged for translation
- [ ] `DEVELOPMENT.md` or `docs/` updated if setup or behaviour changed
