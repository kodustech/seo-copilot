# mcp-server (stdio mode, local dev only)

Standalone entrypoint for running the MCP server over stdio — useful for local development and debugging without needing the seo-copilot Next.js app running.

**Production uses HTTP at `/api/mcp`** (see `seo-copilot/app/api/mcp/route.ts`). This folder is just for local stdio testing.

## What's here

- `src/index.ts` — stdio entrypoint, imports the shared factory from `@/lib/mcp/server`
- `tsconfig.json` — extends the root tsconfig

No own `package.json`. Dependencies (`@modelcontextprotocol/sdk`, `tsx`, `zod-to-json-schema`) are in the seo-copilot root `package.json`.

## Running

From the seo-copilot root:

```bash
npm run mcp
```

That runs `tsx mcp-server/src/index.ts`, which connects via stdio.

You should see:

```
[mcp/stdio] seo-copilot ready. Registered N tools (skipped 0). User: growth@kodus.io
```

The process stays attached. Connect with any MCP stdio client.

## When to use stdio vs HTTP

| | stdio (this folder) | HTTP (`/api/mcp`) |
|---|---|---|
| **Use case** | Local debugging | Production (Junior + Ed via Claude Code) |
| **Setup** | Clone repo + `npm install` | Just configure `.mcp.json` with URL + token |
| **Auth** | None (filesystem access = trust) | Bearer token via `MCP_AUTH_TOKEN` env var |
| **Hot reload** | Yes (tsx) | Yes (Next.js dev mode) |
| **Multi-user** | No (1 process per user) | Yes (1 endpoint, many clients) |

## Spec

See `kodus-growth/specs/setup/18-seo-copilot-mcp-export.md` for full architecture.
