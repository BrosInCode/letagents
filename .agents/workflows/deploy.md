---
description: Deploy letagents to production (letagents.chat)
---

# Deploy to Production

Deploys the `staging` branch to `letagents.chat` via Docker + GHCR.

## Automatic Deployment (Default)

Deployment is **automatic**. When code is merged to `staging`:

1. CI runs type checks and builds
2. Docker image is built and pushed to `ghcr.io/brosincode/letagents`
3. CD job SSHs into the server, pulls the new image, runs migrations, restarts
4. Health check runs automatically — rolls back on failure

**You do not need to do anything manually for a normal deploy.**

To monitor: check GitHub Actions at https://github.com/BrosInCode/letagents/actions

## Manual Deploy (Emergency Only)

If CI/CD is broken and you need to deploy manually:

// turbo-all

1. SSH into server and pull + restart:
```bash
ssh emmy@134.209.165.143 "cd ~/letagents && git pull origin staging && docker compose build && docker compose up -d"
```

2. Verify the server is healthy:
```bash
curl -s https://letagents.chat/api/health
```

Expected output: `{"status":"ok","service":"letagents-api"}`

3. If npm publish is also needed (new MCP client features), bump version first locally, then:
```bash
cd /Users/emmyleke/Projects/startup/letagents && npm publish
```
This will prompt for an OTP code — ask the user.

## Architecture

| Component | Detail |
|-----------|--------|
| **App** | Docker container `letagents-api` on port 3001 |
| **Image** | `ghcr.io/brosincode/letagents:latest` (+ SHA tags) |
| **Database** | Postgres 15 in container `pinflix-server-db-1` |
| **Reverse proxy** | Nginx with Let's Encrypt SSL |
| **Branch** | `staging` is the deployed branch |
| **CI/CD** | GitHub Actions → GHCR → SSH deploy |

## Troubleshooting

**Deploy failed (GitHub Actions):**
```bash
gh run list --branch staging --limit 3
gh run view <run-id> --log-failed
```

**Container won't start (502 Bad Gateway):**
```bash
ssh emmy@134.209.165.143 "docker compose -f ~/letagents/docker-compose.yml logs --tail 30"
```

**Roll back to previous image:**
```bash
ssh emmy@134.209.165.143 "cd ~/letagents && docker compose pull ghcr.io/brosincode/letagents:sha-<previous-sha> && docker compose up -d"
```

**Vue app not loading (blank page):**
- Check `LETAGENTS_WEB_MODE=vue` is set in `.env` or `docker-compose.yml`
- Verify Vue build exists in container: `docker exec letagents-api ls src/web/dist/`

## Important
- **Never use systemd** — the `letagents` systemd unit is disabled. Docker handles everything.
- **Always deploy via staging merge** — CD is automatic.
- The server `.env` file contains secrets (DB_URL, GitHub OAuth). Never commit it.
