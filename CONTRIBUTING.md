# Contributing to WP Content Autopilot

Thank you for your interest in contributing!

## Development Setup

```bash
git clone https://github.com/nguyenlong2817/wp-content-autopilot.git
cd wp-content-autopilot
npm install
npm run dev
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with ts-node |
| `npm test` | Run Vitest test suite |
| `npm run typecheck` | TypeScript type checking |
| `npm run build` | Build to dist/ |

## Project Structure

- `src/stages/` — Pipeline stages (0–6)
- `src/gates/` — Quality gates (G1–G8)
- `src/services/` — External integrations (WP, AI, SEO)
- `src/db/` — SQLite database layer
- `src/config/` — Configuration and prompt loading
- `migrations/` — SQLite schema migrations
- `prompts/` — Prompt templates

## Pull Request Guidelines

1. **Branch** from `main`
2. **Test** your changes: `npm test`
3. **Type check**: `npm run typecheck`
4. **Commit** with conventional commit messages:
   - `feat: add new stage handler`
   - `fix: correct SEO meta generation`
   - `docs: update prompt guide`
5. **PR description** should explain what and why

## Code Style

- TypeScript strict mode
- No `any` types without `eslint-disable` comment
- Structured logging via Winston (`logger.info/warn/error`)
- Never log secrets or API keys

## Adding a New AI Provider

1. Create `src/services/my-provider-adapter.ts`
2. Add provider routing in `WriterService.callLlm()` (`src/services/writer.ts`)
3. Add env vars to `.env.example` and `src/config.ts`

## Reporting Issues

Please include:
- Node.js version (`node -v`)
- OS and version
- Steps to reproduce
- Error logs (redact any API keys!)
