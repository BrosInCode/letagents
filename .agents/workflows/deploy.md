---
description: Deploy letagents to production (letagents.chat)
---

# Deploy to Production

Deploys the `staging` branch to the production server at `letagents.chat`.

## Prerequisites
- SSH access to `emmy@134.209.165.143`
- Server is already set up: deploy key, nginx, systemd, Node 22

## Steps

// turbo-all

1. Verify local staging is up to date:
```bash
git checkout staging && git log --oneline -3
```

2. SSH into server and deploy via git pull:
```bash
ssh emmy@134.209.165.143 "cd ~/letagents && git pull origin staging && npm install && npm run build && sudo systemctl restart letagents"
```

3. Verify the server is healthy:
```bash
curl -s https://letagents.chat/api/health
```

Expected output: `{"status":"ok","service":"letagents-api"}`

4. If npm publish is also needed (new MCP client features), bump version first locally, then:
```bash
cd /Users/emmyleke/Projects/startup/letagents && npm publish
```
This will prompt for an OTP code — ask the user.

## Troubleshooting

**Server won't start (502 Bad Gateway):**
```bash
ssh emmy@134.209.165.143 "sudo journalctl -u letagents -n 30 --no-pager"
```

**Missing dependency on server:**
```bash
ssh emmy@134.209.165.143 "cd ~/letagents && npm install && sudo systemctl restart letagents"
```

**Need to deploy the Vue experiment instead of legacy HTML:**
- Build the web app with `npm run build:web`
- Set `LETAGENTS_WEB_MODE=vue` in the experiment server's environment before restarting
- Do not enable `LETAGENTS_WEB_MODE=vue` on the staging server at `letagents.chat`
- Staging does not need `src/web/dist` removed anymore; the server now defaults to legacy unless `LETAGENTS_WEB_MODE=vue` is explicitly set

## Important
- **NEVER rsync to the server** — it overwrites the SQLite database and destroys chat history.
- **Always deploy via `git pull`** — it only touches tracked files, leaving `data/` safe.
- The server tracks `origin/staging`. Only merge to staging what you want deployed.
- `letagents.chat` should run with the default legacy web mode. Vue serving is opt-in via `LETAGENTS_WEB_MODE=vue`.
