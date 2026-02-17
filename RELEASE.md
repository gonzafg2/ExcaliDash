# ExcaliDash v0.4.23-dev

Release date: 2026-02-17

## Upgrading

<details>
<summary>Show upgrade steps</summary>

### Data safety checklist

- Back up backend volume (`dev.db`, secrets) before upgrading.
- Let migrations run on startup (`RUN_MIGRATIONS=true`) for normal deploys.
- Run `docker compose -f docker-compose.prod.yml logs backend --tail=200` after rollout and verify startup/migration status.

### Recommended upgrade (Docker Hub compose)

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

### Pin images to this release (recommended for reproducible deploys)

Edit `docker-compose.prod.yml` and pin the release tags:

```yaml
services:
  backend:
    image: zimengxiong/excalidash-backend:v0.4.23-dev
  frontend:
    image: zimengxiong/excalidash-frontend:v0.4.23-dev
```

Example:

```bash
docker compose -f docker-compose.prod.yml up -d
```

</details>

fix CSRF session swapping, tightend unsasfe allowances, return 401 for inactive accounts
