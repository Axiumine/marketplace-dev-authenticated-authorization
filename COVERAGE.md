# Test quality policy — 100% coverage **and** 100% mutation score, no exceptions

This service requires **100% test coverage on every metric** — statements, branches,
functions, and lines — **and a 100% Stryker mutation score**. Both are hard gates, not targets.

They answer different questions, which is why both exist:

| Gate | Question it answers |
|---|---|
| coverage | did a test *execute* this line? |
| mutation | would a test *fail* if this line were wrong? |

100% coverage with weak assertions is the normal failure mode, and it is invisible to the
coverage number. Mutation testing is what falsifies it: Stryker rewrites `src/` one small
change at a time (`true` → `false`, a string → `""`, a block → `{}`) and re-runs the suite.
A mutant that *survives* is an edit no test noticed.

## The rule

If coverage is below 100% on any metric, the fix is one of:

1. **Add the missing tests** for the uncovered lines / branches / functions.
2. **Delete the code** if it is unreachable or dead.

If the mutation score is below 100%, the fix is one of:

1. **Strengthen the assertion** that should have caught the mutant.
2. **Delete the code** if the mutant proves the branch is dead.
3. **Document an equivalent mutant** with `// Stryker disable next-line <Mutator>: <why>` —
   only when the mutated code provably cannot behave differently on any reachable input.

**Never** lower a threshold to make a run pass. The thresholds are the specification;
red means the work is not done, not that the number is wrong.

## Where it is enforced

| Layer | File | What it does |
|---|---|---|
| Local test run | `vitest.config.mts` → `test.coverage.thresholds` | `yarn test:cov` exits non-zero if any metric < 100% |
| Local mutation run | `stryker.config.mjs` → `thresholds.break` | `yarn test:mutation` exits non-zero if the score < 100 |
| Qodana scan gate | `qodana.yaml` → `failureConditions.testCoverageThresholds` (`total`/`fresh` = 100) | `./qodana.sh` fails the scan if coverage < 100% |
| Git `pre-commit` | `.githooks/pre-commit` | blocks the commit if `yarn test:cov` **or** the Qodana scan fails |
| Git `pre-push` | `.githooks/pre-push` | blocks the push if `yarn lint:check`, `yarn test:cov`, `yarn test:mutation` **or** the Qodana scan fails |

The three coverage layers read the same coverage run (vitest, v8 provider, lcov →
`coverage/lcov.info`, `all: true` over `src/**/*.mts`). Change coverage config in
`vitest.config.mts` only. Qodana has no mutation gate — `pre-push` is the only one.

Both hooks run the scan on purpose. `git merge --no-ff` never fires `pre-commit` —
git runs that hook for `git commit` only — so the merge commit, the one revision
that reaches `origin`, is the single commit no pre-commit scan ever sees. And
Qodana Cloud files each report under the branch it ran on, so a repo scanned only
at commit time never produces a `main`-tagged report to baseline against. Each hook
hands `qodana.sh` `SKIP_TESTS=1`, reusing the `coverage/lcov.info` its own coverage
step just wrote rather than letting the script regenerate it with a test run whose
failure it swallows. `SKIP_QODANA=1` skips the scan alone; the coverage and
mutation gates stay.

## Two projects, one coverage report

`vitest.config.mts` defines two projects; `yarn test:cov` runs both and aggregates coverage:

| Project | Files | Datasources | Purpose |
|---|---|---|---|
| `unit` | `test/*.test.mts` | mocked | pure logic, error paths, prod branches — fast, offline |
| `integration` | `test/integration/*.itest.mts` | **real Redis cluster + real MongoDB** | boots the server via `start()` and drives it over HTTP |

Unlike the logout service, this one opens **both** datasources (`Promise.all([RedisConnect(),
MongoDBConnect()])`), because the refresh gate reads the session from Redis and then loads the
`shopOwner` from MongoDB. The integration project uses the `REDIS_*` / `MONGODB_URI` values
from `.env` (loaded by the sources' own `dotenv.config()`). It overrides only the keyspace prefix
(`REDIS_KEY=marketplaceDev:itest:authenticatedAuthorization:`, a per-service, ACL-allowed namespace —
the `marketplaceDev:itest:` stem is shared across the platform because the Redis ACL grants the test
user exactly that pattern, but the third segment is unique to this service so its integration
suite can run at the same time as the other six's) and `PORT=0` (ephemeral).
Run just one side with `yarn test:unit` / `yarn test:integration`.

Consequence: the coverage gate — and therefore `pre-push` and `./qodana.sh` — needs both the
Redis cluster and MongoDB reachable. That is intentional: 100% here means the server was really
booted and really talked to both, not that a mock returned the expected value.

**The integration suite never writes to MongoDB.** It seeds and deletes its own Redis keys inside
the isolated namespace, and reaches MongoDB only through reads that are expected to miss (a
session pointing at an `_id` that matches no shopOwner). Seeding a real `shopOwner` would
mean writing to the dev database and satisfying its full `$jsonSchema` validator; the happy path
of the `refresh` resolver is covered by the unit project instead.

## Enabling the hook

The `pre-push` hook lives in `.githooks/` (tracked in git). It is activated by:

```bash
git config core.hooksPath .githooks
```

The `prepare` script in `package.json` runs this automatically on `yarn install`, so a
fresh clone is gated after the first install. To verify:

```bash
git config --get core.hooksPath   # -> .githooks
```

## Server boot and Sentry init are covered — do not exclude them

`src/index.mts` (Koa/Apollo wiring, routing, shutdown) and `src/instrument.mts` (Sentry
init) reach 100% through the **integration** project, which boots the real server and hits
`/authenticated-authorization`, `/health`, and an unknown path over HTTP. They are **not**
`v8 ignore`d and must stay that way — the only `v8 ignore` block is the entrypoint tail of
`index.mts` (the `if (NODE_ENV !== 'test')` bootstrap that registers signal handlers and calls
`start()`), which cannot run under the test process without killing the worker via
`process.exit`. Every function it wires (`start`, `gracefulShutdown`, `onUnhandledRejection`,
`onUncaughtException`) is exercised directly by tests, so the ignored block contains only the
wiring, no logic.

## Mutation testing — what is mutated, and what is not

`yarn test:mutation` runs Stryker (`stryker.config.mjs`) with the **vitest** runner over
`vitest.mutation.config.mts`. Two deliberate scope decisions, each of which would otherwise
show up as permanent survivors:

| Setting | Why |
|---|---|
| runs the **`unit` project only** | Stryker re-runs the suite once per mutant. Pointing that at `test/integration/*.itest.mts` would hit the real Redis cluster **and** the real MongoDB hundreds of times inside this service's `marketplaceDev:itest:authenticatedAuthorization:` namespace, where `fileParallelism: false` serialises everything. That namespace is no longer shared with the other six services, but the integration project still hits real infrastructure hundreds of times per mutant — that alone is reason enough to keep Stryker on the `unit` project. Unit tests mock both datasources, so mutant runs stay hermetic and parallel. |
| `!src/graphQLApi/schema/types/**`, `!src/index.mts` | See below. |

There is **no `ignoreStatic`**. It looked, at first, like module-load mutants (the GraphQL type
declarations, `mutations.mts`/`queries.mts`'s `new GraphQLObjectType({...})` calls) were
unkillable in principle — the module is already in the ESM registry by the time Stryker flips
the active mutant, so a naive top-level `import` in the test file never re-evaluates it. That
diagnosis was wrong: the fix is importing the module under test with a dynamic `import()` inside
`beforeAll` instead of at the top of the file, so the load happens inside the test run. Every
test file under `test/` that touches a mutated module now does this — see the comment at the top
of `test/schema.test.mts` and `test/index.unit.test.mts`.

One more wrinkle on top of that: some of these mutants don't just change a value, they make the
`GraphQLObjectType` constructor **throw** (an emptied `fields`/`name`). A throw inside a plain
`beforeAll` fails the hook, and Vitest then reports every `it` in that file as **skipped**, not
failed — a run with nothing passing and nothing failing gives Stryker no test to attribute the
kill to, so the mutant still shows Survived even though the code visibly crashed. The fix is a
`try { …dynamic import… } catch {}` around the import in `beforeAll`: swallowing the error leaves
the binding `undefined`, and whichever assertion dereferences it fails on its own, as an ordinary
per-test failure Stryker can attribute normally.

`src/graphQLApi/schema/types/**` (`Hello2Type`, `RefreshType`) is literal SDL/field wiring with
no branches to mutate meaningfully — every mutant Stryker can produce there (deleting a field,
renaming a string literal) changes the schema shape, not a decision path, so nothing short of
re-asserting the whole SDL verbatim would ever kill one. These are whole files of nothing else,
which is why the exclusion is file-level rather than per-line.

`src/index.mts` is excluded whole-file, but **not** because none of it is unit-tested — most of
it is (`checkRequiredEnv`, `buildValidationRules`, `healthResponse`, `logListening`,
`gracefulShutdown`, `onUnhandledRejection`, `onUncaughtException`, both failure branches of
`start()`, and — since `start (success path)` mocks only `http.Server.prototype.listen`, not
`createServer()` — most of `createServer()`'s own assembly too, are exercised directly by
`test/index.unit.test.mts` and mutate cleanly on their own). The problem is the remainder:
some of `createServer()`'s wiring (Keygrip construction, `bodyParserKoa` options, the Apollo
plugin list, `csrfPrevention`) runs but is never asserted on, the `catch` block's error-log
string is likewise unobserved, and the `if (NODE_ENV !== 'test')` bootstrap tail cannot run
under the test process at all (it would call `process.exit`) — that part is exercised only by
the integration project, which this run does not execute. Verified empirically: with the file
left in `mutate`, Stryker reports 14 `Survived` mutants in the unasserted-but-covered wiring
and 28 more `NoCoverage` in the bootstrap tail and the true HTTP success path (the parts only
`test/integration/index.itest.mts` reaches) — pure noise, since both count against the score
the same as an ordinary survivor. Stryker's `mutate` option only excludes at file granularity,
so there is no way to keep the well-tested functions in scope without also pulling in these;
`index.mts` stays gated by the 100% line/branch coverage requirement instead (see the section
above).

Everything else — the Koa auth middleware, the `refresh` resolver, the Mongo lookup, the DB
teardown — is fully mutated. Current state: **every tested mutant killed, 0 survived**, score 100.00,
~35 s. The instrumented total moves with the source, so read it off the run rather than from here.

### Equivalent mutants

Three mutants are annotated in `src/` with `// Stryker disable next-line`, each above a comment
carrying the reachability argument, and all three are in one file:

- `graphQLApi/schema/mutations/refresh.mts` — the `status` initializer, and the two token-clearing
  assignments (`refreshToken = accessToken = ''`, `accessToken = ''`) inside the `catch` block.
  `tryCatchRethrow(e)` throws unconditionally in every branch it has, so the `catch` block never
  reaches the function's one `return` statement; none of these three values can ever be observed
  by a caller.

Do not add to this list without the same kind of argument. "I could not think of a test" is not
an equivalence proof.

### Writing tests that kill

The survivors this run started with were all `catch`-block bookkeeping the tests only checked via
`rejects.toThrow('Internal Server Error')` — enough to prove *a* rejection happened, not that the
specific dead-store values inside `catch` were the ones the resolver actually wrote. Working out
*why* each one survived (tracing whether the value is ever read again before the function throws
or returns) is what turned three of the four original survivors into documented equivalent
mutants instead of new tests: the values genuinely aren't observable, so no test could have killed
them honestly.

## Running it

```bash
yarn test:cov       # coverage + threshold check (the source of truth)
yarn test:mutation  # Stryker; report at reports/mutation/mutation.html
./qodana.sh         # full Qodana Ultimate scan, incl. the 100% coverage gate
```

`git push` runs the first two, in that order, and blocks on either.
