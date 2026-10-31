# Mercury Web Chat

A web chat for Mercury 3 with no login and no stored history. It runs as a Cloudflare Worker and deploys from GitHub.

- Streaming chat with Mercury 3 (Inception Labs)
- Voice messages: Whisper transcribes them, then the model answers
- Image questions: Llama 4 Scout (Workers AI) answers about the picture
- Documents (PDF, DOCX, XLSX, and other supported formats): converted to Markdown by Cloudflare, then the model answers

**Privacy:** the server stores nothing. The conversation lives in the browser tab's memory. Refreshing the page or pressing *New chat* clears it.

## Deploy from GitHub

1. **Cloudflare account.** Sign up at cloudflare.com (free). Workers AI is included in the free allocation.
2. **Inception API key.** Create one in your Inception Labs dashboard.
3. **Cloudflare API token.** Dashboard → My Profile → API Tokens → Create Token → use the *Edit Cloudflare Workers* template. Copy the token and your *Account ID* (shown on the Workers overview page).
4. **Push this folder to a GitHub repository** (the default branch should be `main`).
5. **Add three GitHub secrets** under repo → Settings → Secrets and variables → Actions:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   - `INCEPTION_API_KEY`
6. **Run the deploy.** Each push to `main` deploys automatically, or start it from the Actions tab (*Run workflow*).
7. Your site is live at `https://mercury-web-chat.<your-subdomain>.workers.dev`. Change the name in `wrangler.toml` to change the address.

**Alternative without GitHub Actions:** in the Cloudflare dashboard, use Workers & Pages → Create → Import a repository. Then add `INCEPTION_API_KEY` under Settings → Variables and secrets as an encrypted secret.

## Settings

Secrets are set in GitHub (or the Cloudflare dashboard). Plain settings live in `[vars]` in `wrangler.toml`.

| Name | Type | Default | Purpose |
|---|---|---|---|
| `INCEPTION_API_KEY` | secret | none, **required** | Your Inception key |
| `INCEPTION_MODEL` | var | `mercury-3` | Model name |
| `INCEPTION_API_URL` | var | Inception chat endpoint | Change only if the endpoint moves |
| `INCEPTION_TEMPERATURE` | var | `0.3` | 0 to 2 |
| `INCEPTION_REASONING_EFFORT` | var | `medium` | `low`, `medium`, `high`, or `off` |
| `APP_TITLE` | var | `Mercury Chat` | Page title |
| `MAX_UPLOAD_MB` | var | `10` | Largest file, image, or recording accepted |
| `SYSTEM_PROMPT` | secret or var | built-in prompt in `src/prompt.js` | Replaces the whole system prompt |
| `TRANSCRIBE_MODEL` | var | Whisper large v3 turbo | Voice transcription model |
| `VISION_MODEL` | var | Llama 4 Scout | Image model |

Voice, image, and file features use the Workers AI binding (`[ai] binding = "AI"`). It is already in `wrangler.toml`. If it's disabled, only text chat works.

To change a setting, edit `wrangler.toml` (or the secret in GitHub) and push. The site redeploys.

## Run locally

```bash
npm install
cp .dev.vars.example .dev.vars   # then put your real key in .dev.vars
npx wrangler login               # needed so the Workers AI features run
npm run dev                      # opens on http://localhost:8787
```

## Security and cost (read this)

There is no login, so **anyone who has the URL can use your Inception and Workers AI quota**. Before you share the link:

- Set a spending limit or a usage cap in your Inception dashboard.
- Add a rate limit: Cloudflare dashboard → your Worker's domain → Security → WAF → Rate limiting rules, matching `/api/*`.
- Rotate `INCEPTION_API_KEY` if it was ever pasted in a public place.

## Limits and what's not included

- Each request is independent, so the model only sees the conversation the browser tab holds.
- Included: text chat, voice, images, documents.
- Not included: web search, tool calls, the Telegram bot's reminders, digests, and stored history. These need a database and are a separate project.
- The Markdown renderer and the Whisper input formats are standard, but test a real voice note and a real PDF once after you deploy. Browser recordings may come out as WebM or MP4, and Whisper needs to accept that format.
