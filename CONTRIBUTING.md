# Contributing to ProviderPlaneAI

Contributions are welcome, whether they come as code, docs, issues, or feedback.

## Development

```bash
npm run dev
npm run build
npm run test
npm run test:watch
npm run lint
npm run lint:fix
npm run docs
npm run perf:quick
```

## Integration Testing

- Deterministic integration tests:
  - `npm run test:integration`
- Provider-backed live integration tests:
  - `RUN_WORKFLOW_LIVE_INTEGRATION=1 npm run test:integration:live`
  - requires `OPENAI_API_KEY_1`, `GEMINI_API_KEY_1`, and `ANTHROPIC_API_KEY_1`

Performance artifacts are generated under `scripts/perf/results` as both JSON and Markdown:
- `npm run perf:quick` (5 cold-import runs)
- `npm run perf` (20 cold-import runs)
- `npm run perf:full` (30 cold-import runs)
- `npm run perf:ci` (30 runs + CI threshold checks; exits non-zero on regression)

## Publishing Notes

Published tarballs intentionally exclude local development entry files and other non-runtime artifacts. If you add a local-only example or playground entry, make sure it is excluded consistently anywhere these files control build, docs, test, lint, formatting, repository hygiene, or package inputs:

- `tsconfig.build.json`
- `typedoc.json`
- `vitest.config.ts`
- `eslint.config.js`
- `.gitignore`
- `.prettierignore`
- `package.json` (`files`)

## Before Opening a PR

- Run `npm run build`, `npm run test`, and `npm run lint`.
- Update docs or runnable examples when a public API or workflow pattern changes.
- Keep release-facing changes described in user-facing language so release notes stay readable.
- Merges to `main` feed the release and site-deploy automation, so docs-facing and release-facing changes should be ready before merge.

## Pull Request Titles

`release-please` derives release notes from merged PR history, so PR titles should follow this format:

```text
type(scope): short summary
```

Optional issue link format:

```text
type(scope): short summary (#123)
```

Supported types:
- `feat`
- `fix`
- `docs`
- `refactor`
- `test`
- `chore`
- `perf`

Examples:
- `feat(workflow): add persistence resume example`
- `fix(client): prevent duplicate provider registration (#121)`
- `docs(dev): refine examples page copy`

If you want the issue to close automatically when the PR merges, add `Closes #123` in the PR body.

## Git Hooks

We use Husky to enforce linting and tests. Please do not bypass hooks unless absolutely necessary.
