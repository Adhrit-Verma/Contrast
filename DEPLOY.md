# Deploying Contrast

There is no domain and no public TLS cert for this box, and Basic Auth over plain HTTP would
send credentials in the clear — so access goes over **Tailscale**, not the public internet.
`tailscale serve` bridges the dashboard's own `127.0.0.1`-only bind (a deliberate safety
property in `src/ui/server.js`, unchanged here) to your private tailnet with a real HTTPS
certificate, no domain purchase and no password prompt required.

Everything in this file runs **on the VPS**, over SSH. Nothing here can be run from this
machine — there is no access to the VPS from this session.

## 1. Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # log out and back in once, so `docker` needs no sudo
```

Verify: `docker --version` and `docker compose version` both print something.

## 2. Install Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

This prints a login URL — open it once in a browser to join the box to your tailnet (Tailscale
is free for personal use up to 100 devices). Note the machine name it assigns
(`sudo tailscale status` shows it, e.g. `contabo-vps`).

Do the same `tailscale up` on whatever laptop/phone you'll use to reach the dashboard from.

## 3. Get the code onto the VPS

Existing nginx on the box is untouched by any of this — Tailscale Serve binds to the
`tailscale0` interface only, never port 80/443 on the public interface.

```bash
git clone <your-repo-url> contrast && cd contrast
mkdir -p sessions runs   # bind-mount targets — Docker will create them as root-owned otherwise
```

`config.json` is already committed to the repo, so it arrives with the clone — no template
step needed. Edit it now if you want to add real client sites beyond the built-in `demo`.

## 4. Build and start

```bash
docker compose up -d --build
docker compose logs -f    # Ctrl-C once you see "dashboard → http://localhost:4321"
```

`config.json`, `sessions/`, and `runs/` are bind-mounted from the host (see `docker-compose.yml`)
— they survive `docker compose down`, image rebuilds, and stay hand-editable exactly as the
README promises. The container uses `network_mode: host`, so "the dashboard's `127.0.0.1`" and
"the VPS's own `127.0.0.1`" are the same address once it's running.

## 5. Expose it to your tailnet

```bash
sudo tailscale serve --bg 4321
tailscale serve status
```

This gives you a URL like `https://contabo-vps.your-tailnet.ts.net` — reachable from any device
on your tailnet, nowhere else. Tailscale issues and renews the certificate itself; there is
nothing to configure.

## 6. Verify — the actual "done" condition

From a tailnet-joined device (not the VPS itself):

1. Open `https://<your-machine-name>.<your-tailnet>.ts.net` — the composer ("What should I
   audit?") should load.
2. Paste `https://www.w3.org/WAI/demos/bad/before/home.html` (the `demo` client already in
   `config.json`, 3 pages, no login) and start a scan.
3. Watch it complete, open the run, confirm the report renders with real findings.

If step 2 hangs on "Connecting to the browser…": headless jobs run inside the container by
default (`A11Y_HEADLESS=1` is set by the dashboard for every job it spawns — see
`src/ui/jobs.js`), so this should just work without a display. If a page's own scan phase runs
long, that's the page-timeout budget doing its job (see `crawl.pageTimeoutMs` in
`config.json`), not a broken deploy.

## Updating later

```bash
git pull
docker compose up -d --build
```

Or, once `.github/workflows/ci.yml` has pushed an image to GHCR on a run you trust:

```bash
docker compose pull && docker compose up -d
```

(Swap `docker-compose.yml`'s `build: .` for `image: ghcr.io/<owner>/<repo>:latest` first if you
want to pull instead of rebuild locally every time — left as `build: .` by default so the VPS
never needs a GHCR login.)

**Auto-deploy is set up**: `.github/workflows/ci.yml`'s `deploy` job SSHes into the VPS on every
push to `main` (after tests pass and the image builds) and runs `git pull && docker compose up
-d --build`. It needs three repository secrets — Settings → Secrets and variables → Actions:

- `VPS_HOST` — the VPS's IP
- `VPS_USER` — the SSH user (`adhrith`)
- `VPS_SSH_KEY` — the **private** half of a *dedicated* deploy keypair, not a personal one:
  ```bash
  ssh-keygen -t ed25519 -f ~/.ssh/contrast_deploy -N ""
  ssh-copy-id -i ~/.ssh/contrast_deploy.pub adhrith@<vps-ip>
  ```
  Paste the contents of `~/.ssh/contrast_deploy` (no `.pub`) as the secret value. Using a
  dedicated key means it can be revoked from `~/.ssh/authorized_keys` on the VPS without
  touching your own access, if it's ever rotated or the repo's secrets are ever exposed.

Without these three secrets set, the `deploy` job simply fails (nothing to guess at) — `test`
and `build-and-push` still run and pass on their own.

## Step 6: the public scan funnel

A second, genuinely public service (`contrast-public` in `docker-compose.yml`) — separate
process, separate database, no access to `config.json` or `sessions/`. Bare IP + port for now
(no domain yet), so open the firewall for it and bring it up:

```bash
sudo ufw allow 8080/tcp    # or whatever firewall this VPS actually uses — check first
docker compose up -d contrast-public
```

Visit `http://<vps-public-ip>:8080/` from any machine (not just the tailnet) — paste a public
URL, watch it scan, get a shareable `/r/<runId>` link. Defaults: 5 pages/scan, 3 scans/hour/IP,
2 scans running at once — override via `PUBLIC_MAX_PAGES`, `PUBLIC_RATE_LIMIT`,
`PUBLIC_MAX_CONCURRENT` in `docker-compose.yml`.

**No TLS yet** — plaintext HTTP, by your own choice for now. The only data in flight is a URL to
scan and the resulting report; no credentials or API keys ever touch this service. Put it behind
nginx + certbot once a domain exists (step 7 will want one anyway).

**Verify it for real** (the checklist's own "do this now"):
```bash
curl -X POST http://<vps-ip>:8080/scan -H 'content-type: application/json' \
  -d '{"url":"https://www.w3.org/WAI/demos/bad/before/home.html"}'
# poll the statusUrl it returns, then open the reportUrl in an incognito window
# from a different device — it must load with no login of any kind
for i in 1 2 3 4; do curl -s -o /dev/null -w "%{http_code}\n" -X POST http://<vps-ip>:8080/scan \
  -H 'content-type: application/json' -d '{"url":"https://example.com"}'; done
# expect 202, 202, 202, then 429 once PUBLIC_RATE_LIMIT is exceeded
```

## Step 7: the landing page

Same `contrast-public` service, no new deploy step — `git pull` and `docker compose up -d
--build contrast-public` picks it up. The landing page is now at `/`, the scan tool moved to
`/scan` (linked from the landing page's CTA and top-nav).

**Verify** (the checklist's own "do this now" — view it at mobile width, confirm the CTA is
above the fold): open `http://<vps-ip>:8080/` on an actual phone, or in a desktop browser's
device toolbar at ~375px wide. The "Scan your site free →" button should be visible without
scrolling.

## Gemini API key

Set it once through the dashboard's **Settings** tab after first boot — it's encrypted at rest
in `sessions/.secrets.json` (survives container restarts via the bind mount) and never touches
`config.json`. Alternatively, put `GEMINI_API_KEY=...` in a `.env` file next to
`docker-compose.yml` before the first `docker compose up`.

Remember: **`ai.tier` defaults to `"free"`** in `config.json`. Leave it there for testing;
set it to `"paid"` before scanning anything that isn't your own test sites (see README →
Safety).
