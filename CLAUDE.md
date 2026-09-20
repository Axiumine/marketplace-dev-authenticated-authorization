# marketplace-dev-authenticated-authorization

Backend svc 7 of 9. ShopOwner tier, authorization concern. Port 4029, endpoint
`/authenticated-authorization`. One mutation: `refresh`.

**Read parent first** — [`../../../CLAUDE.md`](https://github.com/Axiumine/fullstack-marketplace-blueprint/blob/main/CLAUDE.md)
Tier/concern split, port table, terminology, auth model live there. Not here.

| Need | File |
|---|---|
| what this svc is, what code still lives here and why | [`README.md`](./README.md) |
| hook internals, gate order, node selection, why the mutation gate is hook-only | [`REPO.md`](./REPO.md) |
| why the three authz svcs stay three | parent [`docs/decisions/authorization-service-consolidation.md`](https://github.com/Axiumine/fullstack-marketplace-blueprint/blob/main/docs/decisions/authorization-service-consolidation.md) |
| GitNexus rules, resources, CLI skills, registry name | [`AGENTS.md`](./AGENTS.md) |

Business queries → `marketplace-dev-authenticated-resource` (4026). Logout →
`marketplace-dev-authenticated-logout` (4030), all three tiers.

## ⚠️ NEVER run the mutation gate by hand

`yarn test:mutation` is **hook-only** — `pre-push` calls it, nothing else does: not to check a change,
not before a commit, not on one file, not to confirm a survivor is fixed. Never `npx stryker run`
either. To reproduce a survivor, apply the mutant by hand in the source and run `yarn test` instead —
seconds, and it names the tests that should have failed. Why: [`REPO.md`](./REPO.md).
⚠️ Since ADR-055 the script has a second caller, `.github/workflows/gates.yml`, which runs it on
every pull request — two callers, both automated, and a hand is neither.

## ⚠️ Decided, not re-openable

Most of this service's body lives in `marketplace-common`, deliberately. Do not re-inline the helpers,
and do not go the other way and merge the three authorization services into one — both directions are a
decision the user has already taken, against. Survey and rejected alternatives:
[`docs/decisions/authorization-service-consolidation.md`](https://github.com/Axiumine/fullstack-marketplace-blueprint/blob/main/docs/decisions/authorization-service-consolidation.md).

## Rules

- **Never commit on `main`.** Branch first: `git switch -c <type>/<slug>`. Merge = user decision alone.
- Merged → delete branch: `git branch -d <slug>`. `-d` only. `-D` never.
- **No remote.** Push-on-request: no `git push` unless the user asked for it in that message.
- **Never lower a coverage or mutation threshold, and never remove a gate.** Threshold miss → write the
  missing test. Bypasses (`SKIP_QODANA=1`, `--no-verify`) are gate removals: use only when the user says so.
- Tabs, not spaces. eslint + prettier both enforce.
- English only — identifiers, comments, fixtures. No exception.
- **Run `impact({target, repo})` before editing a symbol and `detect_changes()` before committing**;
  `repo:` is mandatory and must be a `marketplace*` registry name. Details: [`AGENTS.md`](./AGENTS.md).

## Gates

commit → secret guard, lint, types, coverage, Qodana. push → same + semgrep (SAST) + trivy (dependency
advisories) + mutation. All blocking. Why: [`REPO.md`](./REPO.md).
