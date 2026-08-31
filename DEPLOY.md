# 🚀 Deploying ARIA OS — Phone, Vercel & Supabase

## Do you need Supabase?

| Setup | Supabase needed? |
|---|---|
| **Laptop / desktop always at home** (or a Raspberry Pi / VPS) | ❌ No — data lives in `data/` on your disk. Nothing else to set up. |
| **Vercel** (or any serverless host) | ✅ Yes — serverless has no persistent disk, so your brain/state must live in an external database. |

The code supports **both modes with the same codebase**. If `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` env vars are present, everything is stored in a single Supabase table; otherwise it uses local files like normal.

## 📱 Use it on your phone

1. Get ARIA OS reachable from your phone (deploy on Vercel below, or run at home and expose it — see “Running at home”).
2. Open the URL in your phone browser → sign in if you set `ARIA_PASSWORD`.
3. Tap **📲 install** (Hub header or Settings) — on iPhone use Safari → Share → *Add to Home Screen*.
4. **Settings → Enable morning notifications** → at 06:00 Nairobi time the brief lands on your lock screen with sound.
5. The app now runs full-screen like a native app, with a bottom tab bar (Hub · Brief · Inbox · Brain · ARIA · Settings), offline access to your latest brief, and voice greetings.

## ▲ Hosting on Vercel (free)

### 1. Create the Supabase database (~3 min)
1. Go to [supabase.com](https://supabase.com) → **New project** (free tier is enough).
2. Once created, open **Project Settings → API**. You need:
   - `Project URL` (this is `SUPABASE_URL`)
   - `service_role` secret key (this is `SUPABASE_SERVICE_KEY` — keep it secret)
3. Open the **SQL Editor** in Supabase and run:

```sql
create table if not exists aria_docs (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
```

That's the whole schema — ARIA stores its state/settings as documents in this one table.

### 2. Push this repo to GitHub, then import to Vercel
1. Push the repo to your GitHub.
2. [vercel.com](https://vercel.com) → **Add New → Project** → import the repo (framework: **Other** — it's auto-detected via `vercel.json` + `api/`).
3. Add **Environment Variables** (Project → Settings → Environment Variables):

| Name | Value | Required? |
|---|---|---|
| `SUPABASE_URL` | your Supabase project URL | ✅ |
| `SUPABASE_SERVICE_KEY` | service_role secret | ✅ |
| `ARIA_PASSWORD` | a private passphrase — locks the dashboard & API | recommended |
| `CRON_SECRET` | any random string, e.g. `openssl rand -hex 24` | recommended |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | generate: `npx web-push generate-vapid-keys` | for phone notifications |
| `OLLAMA_URL` | only if you run Ollama somewhere reachable | optional |

4. **Deploy.** Your OS is live at `https://your-project.vercel.app`.

### 3. Verify the morning cron
`vercel.json` schedules `POST/GET /api/cron/morning` daily at **03:00 UTC = 06:00 Nairobi**. Vercel runs it automatically on paid accounts; on the free Hobby plan crons run once/day but you can hit it yourself with a scheduled service as backup:

```bash
curl -X POST https://your-project.vercel.app/api/cron/morning -H "x-cron-secret: YOUR_CRON_SECRET"
```

On Vercel, Ollama isn't available — the built-in **offline engine** handles briefs and the assistant (it's genuinely useful), and the brief remains full-quality since it's compiled from your real data. For full LLM reasoning on Vercel, point `OLLAMA_URL` at a hosted Ollama (e.g. a $5 VM running `ollama serve`) — or run everything at home instead.

## 🏠 Running at home (no Supabase, full Ollama)

```bash
npm install
npm start                          # → http://localhost:3000
# keep it alive 24/7:
npm install -g pm2 && pm2 start server/index.js --name aria-os && pm2 save
```

To reach it from your phone outside home Wi-Fi, expose it with one of:
- **Tailscale** (easiest, private): install on PC + phone, open `http://<pc-ip>:3000` from the phone anywhere.
- **Cloudflare Tunnel**: `cloudflared tunnel --url http://localhost:3000` → gives you a public URL.
- Set `ARIA_PASSWORD` on the server env before exposing anything publicly.

> 💡 **Best of both:** run it at home (full privacy, Ollama, zero cost) **and** keep a Vercel+Supabase deployment as your phone's go-to when the home machine is off. Same repo, two deployments.

## 🔐 Security notes

- `ARIA_PASSWORD` protects everything (dashboard + API) with one passphrase; stored per-device so you type it once per phone/laptop.
- `SUPABASE_SERVICE_KEY` and `CRON_SECRET` live only in Vercel env vars — never in the repo.
- On your home network without a tunnel? You're already private.
