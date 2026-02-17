# AGENTS.md

This file helps two kinds of agents work on ExcaliDash.

## Role 1: Agent as helper (user asks for guidance)

Answer operational questions first, then point to the exact commands or files.

For setup and troubleshooting, start here.

- Goal check: confirm whether the user needs local dev, Docker, or E2E.
- Use the `README.md` and `e2e/README.md` as the primary operator references.
- If the question is about one error, find the nearest environment or script path before proposing code changes.
- If startup is blocked, collect these values from the user first:
  - Are they using local compose, `make`, or direct `npm`?
  - What do `git status`, `docker compose ps`, and `docker compose logs` show?
  - Which auth mode is configured (`AUTH_MODE`)?

## Role 2: Agent as contributor (code work)

Understand runtime first, then touch code with local tests if requested.

- Confirm behavior in three layers before editing:
  - docs (`README.md`, this file)
  - runtime wiring (`docker-*.yml`, `Dockerfile`, entrypoints)
  - source (`backend/src`, `frontend/src`)
- Preserve patterns used in the repo:
  - backend TypeScript server in `backend/src`
  - frontend React/Vite app in `frontend/src`
- Prefer minimal edits and keep env-sensitive behavior documented before/after changes.
- Do not change migration/secret handling unless explicitly requested.

## Repository map (high signal)

- `backend/`: Express API, Prisma schema, auth, sockets, scripts, Docker runtime.
- `frontend/`: React UI, API client wiring, Vite config/build pipeline.
- `e2e/`: Playwright tests and compose-based test runner.
- `docker-compose.yml`: local compose setup for source builds.
- `docker-compose.prod.yml`: production-style compose using published images.
- `Makefile`: repo-wide orchestration commands.
- `README.md`: user-facing installation and operational docs.
- `VERSION`: version string used in builds.

## Quick setup: local development

Dependencies:
- Node.js 20+
- npm
- SQLite-supported environment (default)
- Docker + Docker Compose if using compose path

Install:
- `npm i` in each package: `make install` (or `cd backend && npm install`, `cd frontend && npm install`, `cd e2e && npm install`)

Start backend + frontend in tmux:
- `make dev` (starts `backend` and `frontend` in a split tmux session)
- `make dev-stop` to stop
- Backend dev env:
  - `cd backend`
  - `cp .env.example .env`
  - `npx prisma generate`
  - `npx prisma db push`
  - `npm run dev`
- Frontend dev env:
  - `cd frontend`
  - `cp .env.example .env`
  - `npm install`
  - `npm run dev`

Docker quickstart:
- `docker compose up -d` (from root, uses `docker-compose.yml`)
- `docker compose -f docker-compose.prod.yml pull` and `up -d` for image-based deploy
- App default host ports: frontend `6767`, backend `8000` (inside compose)

E2E quickstart:
- `cd e2e && npm install`
- `npx playwright install chromium`
- `npm test`
- If using existing services: `NO_SERVER=true npm test`
- Dockerized: `npm run docker:test`

## Environment variables

Backend runtime reads `.env` via `backend/.env` and `backend/src/config.ts`.
Frontend runtime uses Vite `import.meta.env` values from `frontend/.env` and build-time defines.

Backend base variables:
- `PORT` (default `8000`)
- `NODE_ENV` (`development` / `production`)
- `DATABASE_URL` (`file:...` default via `backend/.env` and resolver)
- `FRONTEND_URL` (comma-separated allowed origins)
- `TRUST_PROXY` (`true`, `false`, or positive hop count)
- `AUTH_MODE` (`local`, `hybrid`, `oidc_enforced`)
- `JWT_SECRET` (required in production; must be >= 32 chars and non-placeholder)
- `CSRF_SECRET` (required for stable CSRF across restarts in production setups)
- `JWT_ACCESS_EXPIRES_IN` (default `15m`)
- `JWT_REFRESH_EXPIRES_IN` (default `7d`)
- `RATE_LIMIT_MAX_REQUESTS` (default `1000`)
- `CSRF_MAX_REQUESTS` (default `60`)
- `ENABLE_PASSWORD_RESET` (`true` to enable)
- `ENABLE_REFRESH_TOKEN_ROTATION` (`true`/`false`, default `true`)
- `ENABLE_AUDIT_LOGGING` (`true`/`false`, default `false`)
- `BOOTSTRAP_SETUP_CODE_TTL_MS` (default `900000`)
- `BOOTSTRAP_SETUP_CODE_MAX_ATTEMPTS` (default `10`)
- `UPDATE_CHECK_OUTBOUND` (`true`/`false`/`1`/`yes`, default `true`)
- `UPDATE_CHECK_GITHUB_TOKEN` (optional token for GitHub API)
- `GITHUB_TOKEN` (fallback token if update token missing)
- `DRAWINGS_CACHE_TTL_MS` (ms, default `5000`)
- `DEBUG_CSRF` (`true` enables debug logs)
- `DISABLE_ONBOARDING_GATE` (`true` bypasses onboarding gate; not recommended)
- `OIDC_PROVIDER_NAME` (default `OIDC`, optional unless OIDC mode enabled)
- `OIDC_ISSUER_URL` (required in `hybrid`/`oidc_enforced`)
- `OIDC_CLIENT_ID` (required in OIDC modes)
- `OIDC_CLIENT_SECRET` (required in OIDC modes)
- `OIDC_REDIRECT_URI` (required and HTTPS in production in OIDC modes)
- `OIDC_SCOPES` (default `openid profile email`)
- `OIDC_EMAIL_CLAIM` (default `email`)
- `OIDC_EMAIL_VERIFIED_CLAIM` (default `email_verified`)
- `OIDC_REQUIRE_EMAIL_VERIFIED` (default `true`)
- `OIDC_JIT_PROVISIONING` (default `true`)
- `OIDC_FIRST_USER_ADMIN` (default `true`)

Backend Docker/env control variables:
- `RUN_MIGRATIONS` (`true`/`1` default true in entrypoint)
- `MIGRATION_LOCK_TIMEOUT_SECONDS` (default `120`)
- `JWT_SECRET` and `CSRF_SECRET` persistence support (`.jwt_secret`, `.csrf_secret` in volume)

Frontend variables:
- `VITE_API_URL` (default `/api`)
- `VITE_APP_VERSION` (from build-time metadata)
- `VITE_APP_BUILD_LABEL` (build metadata label)
- `BACKEND_URL` (frontend container entrypoint only; default `backend:8000`, injected into nginx template)

E2E variables:
- `BASE_URL` (default `http://localhost:5173`)
- `API_URL` (default `http://localhost:8000`)
- `HEADED` (`true` to show browser)
- `NO_SERVER` (`true` to skip starting servers)
- `CI` (ci-mode behavior in Playwright config)

## Architecture notes for contributor agents

Backend entrypoint flow:
- `backend/src/config.ts` loads and validates environment variables.
- `backend/src/index.ts` creates express app, socket.io server, middleware, routes, and startup-time guards.
- `backend/src/auth.ts`, `backend/src/auth/*`, and `backend/src/routes/*` contain auth/session/onboarding logic.
- `backend/src/db/prisma.ts` wraps Prisma client and caches in non-production.
- `backend/src/security.ts` and `backend/src/routes/system/update.ts` contain request security and update-check controls.
- Migration handling for runtime is in `backend/docker-entrypoint.sh`.
- Build pipeline for runtime includes Prisma generation and TypeScript compile in `backend/Dockerfile`.

Frontend architecture notes:
- `frontend/src/api/index.ts` holds API client and auth/update endpoints.
- `frontend/src/pages/` contains route-level features.
- `frontend/src/context/` contains auth/theme state.
- `frontend/src/pages/Editor.tsx` wires Socket.IO and live collaboration.
- `frontend/vite.config.ts` sets Vite proxy to backend in local dev and compile-time app metadata.
- Production serving and backend proxy are handled by `frontend/Dockerfile`, `frontend/nginx.conf.template`, `frontend/docker-entrypoint.sh`.

## Makefile command map

- Install: `make install`, `make dev`, `make dev-backend`, `make dev-frontend`
- Build/test/lint: `make build`, `make lint`, `make test`, `make test-all`, `make test-e2e`, `make test-e2e-docker`
- Docker: `make docker-build`, `make docker-run`, `make docker-run-detached`, `make docker-ps`, `make docker-logs`, `make docker-down`
- Admin/ops helpers: backend scripts under `backend/package.json` (`admin:recover`, `dev:simulate-auth-onboarding:*`) and `backend/scripts/*`

## Decision matrix for agent response style

- For helper agents: prefer concise operational steps, likely culprit ordering, and exact command snippets.
- For contributor agents: include file-level references and rationale in your diff note (why file was touched, where config is validated).
- When asked for design or behavior explanations, include:
  - Config source file
  - Route or component entry point
  - Why this logic exists based on existing defaults/constraints

## Safe first actions for unknown issues

- Confirm env file presence and variables
- Check compose/backend logs before code changes
- Reproduce with minimal path:
  - `make dev`
  - open frontend `http://localhost:6767`
- For startup crashes: inspect missing environment validation errors from `backend/src/config.ts` and entrypoint migration/secrets log lines.
