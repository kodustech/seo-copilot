# @kodus/seo-copilot-mcp

MCP server exposing the seo-copilot tools (`lib/ai/tools.ts`) to Claude Code, Anthropic Desktop, Cursor, Cline, or any MCP client.

**Single source of truth**: the same handlers power the web UI agent (`/api/agent/chat`) and this CLI-friendly MCP wrapper. Zero duplication.

## What this exposes

All 33 tools from `createAgentTools()`:

- Content: `generateIdeas`, `generateKeywords`, `getKeywordHistory`, `generateTitles`, `generateArticle`, `generateSocialPosts`, `generateContentPlan`, `fetchBlogFeed`
- Analytics (BigQuery): `getSearchPerformance`, `getTrafficOverview`, `getTopContent`, `getContentOpportunities`, `comparePerformance`, `getContentDecay`, `getSearchBySegment`, `getPageKeywords`, `exploreDataWarehouse`, `runBigQuery`
- SERP / web research: `analyzeCompetitor`, `searchWeb`, `scrapePage`, `getKeywordVolume`, `analyzeSERP`
- Social: `listSocialAccounts`, `scheduleSocialPost`
- Scheduled jobs: `scheduleJob`, `listScheduledJobs`, `deleteScheduledJob`, `scheduleArticlePublication`
- Kanban: `createKanbanCard`, `moveKanbanCard`, `listKanbanCards`
- Voice: `getVoicePolicy`

## Setup

From the seo-copilot root:

```bash
cd mcp-server
npm install        # installs @modelcontextprotocol/sdk, zod-to-json-schema, tsx
```

The server reuses the parent seo-copilot `.env.local` for Supabase / n8n / Post-Bridge / BigQuery credentials.

## Run modes

### Dev (recommended for now)

```bash
npm run dev
```

Uses `tsx` — hot-reloads on file changes. Stays attached via stdio.

### Production

```bash
npm run build
npm start
```

## Configuration

| Env var | Default | Description |
|---|---|---|
| `MCP_USER_EMAIL` | `growth@kodus.io` | Email used as identity for user-scoped tools (kanban, social schedule, voice policy) |

All other env vars are inherited from the seo-copilot `.env.local` (Supabase, n8n, Post-Bridge, BigQuery, AI providers, etc).

## Connecting from Claude Code

In `kodus-growth/.mcp.json`:

```json
{
  "mcpServers": {
    "seo-copilot": {
      "command": "npx",
      "args": [
        "tsx",
        "/Users/gabrielmalinosqui/dev/kodus/seo-copilot/mcp-server/src/index.ts"
      ],
      "env": {
        "MCP_USER_EMAIL": "growth@kodus.io"
      }
    }
  }
}
```

When Claude Code starts in `kodus-growth/`, it auto-connects and tools become available.

## Smoke test (manual)

```bash
cd /Users/gabrielmalinosqui/dev/kodus/seo-copilot/mcp-server
npm install
npm run dev
```

Should output:

```
[mcp] seo-copilot ready. Registered 33 tools (skipped 0). User: growth@kodus.io
```

The process stays open via stdio. Send a `tools/list` JSON-RPC request to verify tools enumerate.

## Design notes

- **Generic wrapper**: `src/index.ts` iterates `createAgentTools()` and registers each tool. Adding a new tool to `lib/ai/tools.ts` automatically exposes it via MCP after restart.
- **Zod → JSON Schema**: MCP wire format requires JSON Schema. `zod-to-json-schema` handles the conversion.
- **Error surfacing**: tool exceptions return `{ isError: true, content: [{ type: 'text', text: 'Error: ...' }] }` instead of crashing.
- **Auth model (current)**: single `MCP_USER_EMAIL` — Junior + Ed share. For multi-user real-time, future iteration with token-based auth.
- **No HTTP transport (yet)**: stdio-only. Local/desktop use only. To expose remotely, add HTTP+SSE transport in a follow-up.

## Related specs

- [`kodus-growth/specs/setup/18-seo-copilot-mcp-export.md`](../../growth/specs/setup/18-seo-copilot-mcp-export.md) — full architectural spec
