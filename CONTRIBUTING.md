# Contributing to Gitmost

Thanks for helping. Gitmost is a community fork of Docmost; this file covers what you need to
send a change.

## Issues and pull requests

- Report bugs and propose features in [GitHub issues](https://github.com/vvzvlad/gitmost/issues).
  For a bug, include the Gitmost version (shown next to the logo), what you did, what you expected
  and what happened.
- Open pull requests against the **`develop`** branch. Keep one change per pull request and describe
  what it changes and how you checked it.

## Development setup

You need Node.js 22, pnpm 10, PostgreSQL with the `pgvector` extension, and Redis.

```bash
cp .env.example .env      # point DATABASE_URL / REDIS_URL at your services
pnpm install
pnpm build                # builds the shared packages the apps depend on
pnpm dev                  # API server + client
pnpm collab:dev           # the real-time collaboration server, in a second terminal
```

The editor does not connect without the collaboration server. [docs/dev-stand.md](docs/dev-stand.md)
covers the full local setup and its pitfalls; [docs/how-to-test.md](docs/how-to-test.md) covers
testing against a running stand.

In local development, database migrations are not applied automatically:

```bash
pnpm --filter server migration:latest
```

## Checks

Run the checks for the packages you touched:

```bash
pnpm --filter server lint && pnpm --filter server test
pnpm --filter client lint && pnpm --filter client test
pnpm --filter @docmost/mcp test
```

## Conventions

- Code comments are written in English.
- Errors are never swallowed: log the full error and show the user the specific reason.
- Migrations only add tables and columns; they never drop or rewrite Docmost data. A new migration
  must sort after the newest one on `develop`.
- Internal identifiers stay `docmost` (package names, database name, `@docmost/*` aliases) — they keep
  existing Docmost installations compatible. Only the product name is Gitmost.

[AGENTS.md](AGENTS.md) describes the architecture and the design rules the codebase follows.

## License

By contributing you agree that your contribution is licensed under the
[AGPL-3.0](LICENSE), like the rest of the project. Contributions to `packages/mcp` are licensed under
its [MIT license](packages/mcp/LICENSE).
