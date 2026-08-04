/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
	testRunner: 'vitest',
	vitest: {
		configFile: 'vitest.mutation.config.mts'
	},
	coverageAnalysis: 'perTest',
	// ignoreStatic was removed: it was believed to drop only unkillable module-load mutants,
	// but the actual cause of the "unkillable" survivors it was papering over was an
	// attribution artifact — test files imported the module under test at the top of the
	// file, so a mutant that changed module-load behaviour ran during Vitest's file-collection
	// phase, before any test started, and Stryker could not attribute the kill to a test. The
	// fix was importing the module dynamically inside beforeAll/it instead of disabling static
	// mutation. See test files under test/ for the dynamic-import pattern this now relies on.
	reporters: ['clear-text', 'progress', 'html'],
	/**
	 * 28 workers on a 32-thread box. The `4` this replaces was never measured anywhere — the same literal
	 * sat in all nine Stryker configs on the platform, frontend included, where dropping it
	 * cut 59 minutes to 18.
	 *
	 * Measured here, 74 mutants, machine otherwise idle:
	 *
	 *   concurrency 4  → 36s
	 *   concurrency 28 → 34s
	 *
	 * Near enough to a tie, and kept anyway: at this size the run is all fixed cost — sandbox
	 * creation, vitest boot, the dry run — so the extra workers neither help nor hurt. Uniform across
	 * the platform beats a per-repo number that measures nothing.
	 *
	 * ⚠️ "It still scored 100" is **not** what justified this, and must not justify the next change. A
	 * starved worker misses a deadline, its test fails, and Stryker records the mutant as *killed* —
	 * overload inflates the score, so 100 at any concurrency is consistent with a gate that has quietly
	 * stopped checking. At the break threshold there is no headroom for the number to show it.
	 *
	 * What was compared instead is the set of non-killed mutants, where load surfaces first: both runs
	 * ended on the same 4 Ignored, the same files, lines and mutators — identical sets, not equal
	 * counts.
	 * Re-measure that way before touching this.
	 */
	concurrency: 28,
	timeoutMS: 60000,
	// Mutation score is a push gate — see COVERAGE.md. `break` fails the run (exit 1)
	// below this score, which is what the pre-push hook keys off. Raise it as tests
	// improve; never lower it to make a run pass.
	thresholds: { high: 100, low: 95, break: 100 },
	/**
	 * Scan and coverage output, copied into the sandbox for no reason. Stryker's always-ignored list
	 * covers only `node_modules`, `.git`, `/reports`, `*.tsbuildinfo`, `/stryker.log` and `.stryker-tmp`
	 * — `ignorePatterns` itself defaults to empty, and `.qodana/` here runs to tens of megabytes.
	 *
	 * It is not only wasted copying. `disableTypeChecks: true` resolves to the glob
	 * `**\/*.{js,ts,jsx,tsx,html,vue,mjs,mts,cts,cjs}` matched with `dot: true`, so it descends into
	 * dotted directories, and every run logged a `ParseError` trying to strip `@ts-` directives out of
	 * Qodana's own `thirdPartySoftwareList.html`. Stryker swallows that error and carries on, so the
	 * gate stayed green while printing a stack trace nobody could act on.
	 *
	 * Neither directory is an input to any test: both are gitignored build output.
	 */
	ignorePatterns: ['.qodana', 'coverage'],
	mutate: [
		'src/**/*.mts',
		// GraphQL type declarations: literal SDL/field wiring (Hello2Type, RefreshType), no
		// branches to mutate meaningfully.
		'!src/graphQLApi/schema/types/**',
		// Server wiring only: createServer()'s Koa/Apollo assembly, the ENDPOINT/health/404
		// dispatch, and start()'s success branch (the real httpServer.listen) are exercised
		// only by test/integration/index.itest.mts, which this run deliberately does NOT
		// execute (see the header of vitest.mutation.config.mts) — pointing Stryker at the
		// real Redis cluster + MongoDB per mutant is not viable. Verified empirically: with
		// this file left in `mutate`, Stryker reports 14 Survived mutants in wiring that is
		// covered but never asserted on (Keygrip construction, bodyParserKoa options, the
		// Apollo plugin list, csrfPrevention, the catch block's error-log string), plus 28
		// more NoCoverage mutants in the true HTTP success path and the
		// `if (NODE_ENV !== 'test')` bootstrap tail that never runs under any test by
		// construction — pure noise that would sink the score regardless of test quality.
		// The rest of this file — checkRequiredEnv, buildValidationRules, healthResponse,
		// logListening, gracefulShutdown, onUnhandledRejection, onUncaughtException, and
		// start()'s failure branches — IS unit-tested and mutates cleanly on its own. But
		// Stryker's `mutate` option only excludes at file granularity, so there is no way to
		// keep those in scope without also pulling in the untestable 42. index.mts stays
		// gated by the 100% line/branch coverage requirement instead.
		'!src/index.mts'
	]
}
