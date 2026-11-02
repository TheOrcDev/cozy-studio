# Hosted Cozy Studio

Run your Studio as a Neon Function with the UI on Vercel, use it from any browser, and let your agents generate through MCP. Local mode is unaffected. The design is in [ADR 0012](adr/0012-hosted-studio-on-neon-and-vercel.md).

Hosted Studio is for one owner. ChatGPT is the hosted provider.

## What you need

- A Neon account with the `neon` CLI signed in, and a Vercel account with the `vercel` CLI signed in.
- A local Studio where you have already signed in to ChatGPT (its sign-in is copied, not repeated from the server).

## 1. Create the Neon project

```bash
neon projects create --name cozy-studio --region-id aws-eu-central-1
neon link --project-id <project-id>
neon neon-auth enable --branch main
```

## 2. Write `.env.hosted`

`.env.hosted` is ignored by git. Never commit it.

```bash
STUDIO_OWNER_EMAIL=you@example.com
STUDIO_PUBLIC_ORIGIN=https://<your-project>.vercel.app
STUDIO_SESSION_SECRET=<openssl rand -base64 48>
STUDIO_SECRET_KEY=<openssl rand -base64 32>
STUDIO_SWEEP_SECRET=<openssl rand -hex 24>
```

`STUDIO_SECRET_KEY` encrypts your provider sign-in. If you lose it, import the sign-in again.

## 3. Deploy the backend

```bash
neon deploy --env .env.hosted
```

This creates the `studio` function, the `studio-library` bucket and the `sweep` trigger from [neon.ts](../neon.ts). Note the function URL it prints.

## 4. Deploy the UI

1. In [vercel.json](../vercel.json), point the `/api`, `/library`, `/mcp` and `/neon-auth` rewrites at your function URL.
2. Allow your Vercel domain in Neon Auth: `neon neon-auth domain add https://<your-project>.vercel.app`.
3. Build locally and upload only the build output, so no source or secrets leave your machine:

```bash
vercel link --project <your-project>
vercel build --prod
vercel deploy --prebuilt --prod
```

If Vercel gives production a different domain than you expected, update `STUDIO_PUBLIC_ORIGIN` and the Neon Auth domain, then run `neon deploy --env .env.hosted` again.

## 5. Copy your ChatGPT sign-in and create an agent token

```bash
export STUDIO_DATABASE_URL="$(neon cs main)"
bun --env-file=.env.hosted run hosted:admin import-chatgpt
bun --env-file=.env.hosted run hosted:admin token create "Claude Code"
```

The token is shown once. `hosted:admin token list` and `hosted:admin token revoke <id>` manage tokens.

## 6. Sign in and connect agents

Open your Vercel URL, enter `STUDIO_OWNER_EMAIL` and the code Neon Auth emails you. Other accounts can sign in to Neon Auth but get no access to Studio.

To let agents generate, set **Agent access (MCP)** to **Generate and cancel** in Settings. Then connect an agent:

```bash
claude mcp add --transport http cozy-studio https://<your-project>.vercel.app/mcp \
  --header "Authorization: Bearer <agent token>"
```

Agents use the same tools as local MCP, except reading local files. Image URLs in results are signed links valid for 24 hours, so an agent can download them without the token.

## Limits

- Routes that act on the host (updates, onboarding, Codex app-server, output sources, library folders, maintenance, local style installs, reset) and the sprite atlas and animation workflows are not available.
- The first time an instance reads an image, it downloads it from object storage.
- A style pack installed or removed on one instance reaches the others the next time they list style packs. Reload Studio to see it.
- If an instance stops mid-job, the sweeper (every 15 minutes) adopts the job. A ChatGPT job that had already been submitted moves to review instead of being sent twice.
- ChatGPT sign-in endpoints are not a documented API, and hosted requests come from Neon's network.
