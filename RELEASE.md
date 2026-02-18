# ExcaliDash v0.4.26-dev

Release date: 2026-02-18

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
    image: zimengxiong/excalidash-backend:v0.4.26-dev
  frontend:
    image: zimengxiong/excalidash-frontend:v0.4.26-dev
```

Example:

```bash
docker compose -f docker-compose.prod.yml up -d
```

</details>

- Fixed live-collaboration permission enforcement: edit access changes now take effect promptly, preventing continued edits after access is
  revoked.
- Simplified “anyone with the link” sharing by removing the legacy share-token exchange flow and /share/:id; sharing now consistently uses
  the public /shared/:id route.
- Reduced data leakage in shared/public views by no longer exposing the owner’s collection/trash identifiers (collectionId is masked for
  non-owners).
- Improved UX and performance by avoiding background preview writes from the dashboard and by defaulting the editor to a safe non-owner
  access state until loaded.
