# Scrydex API setup (Pokemon TCG import)

Scrydex is the evolution of the Pokemon TCG API (pokemontcg.io). Use it for the canonical import when the official API is slow or flaky.

## Required credentials

Scrydex needs **two** values (from your [Scrydex dashboard](https://scrydex.com/)):

1. **API Key** – from your plan / API keys
2. **Team ID** – from your team (required even for a single user)

## Where to put them

Add these two lines to **`.env.local`** (replace the placeholders with your real values):

```env
# Scrydex (Pokemon TCG import) — get both from https://scrydex.com/ dashboard
SCRYDEX_API_KEY=<paste your Scrydex API key>
SCRYDEX_TEAM_ID=<paste your Scrydex Team ID>
```

**Variables:**

| Variable | Where to get it |
|----------|-----------------|
| `SCRYDEX_API_KEY` | Scrydex dashboard → API Keys |
| `SCRYDEX_TEAM_ID` | Scrydex Account Hub → Your Team (required even for one person) |

Replace `<paste your Scrydex API key>` and `<paste your Scrydex Team ID>` with your actual values (no angle brackets in the final line). No quotes needed unless a value has spaces. Restart the dev server after saving.

## API overview (for implementation)

- **Base URL:** `https://api.scrydex.com/pokemon/v1/`
- **English cards:** `GET https://api.scrydex.com/pokemon/v1/en/cards`
- **English expansions (sets):** `GET https://api.scrydex.com/pokemon/v1/en/expansions`
- **Headers:** `X-Api-Key`, `X-Team-ID` (both required)
- **Pagination:** `page`, `page_size` (max 100 per page for cards and expansions)
- **Response:** `{ data: [...], page, pageSize, totalCount }`

Card object includes `id`, `name`, `number`, `rarity`, `expansion` (id, name, release_date), `images`, `variants` (for pricing). Use `expansion.id` and `expansion.release_date` for set info.

- **Import all English cards:** With dev server running, run `npm run import:scrydex-all` in another terminal.
