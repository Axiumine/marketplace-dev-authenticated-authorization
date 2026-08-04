import { defineConfig } from 'vitest/config'

import { nodeNextResolver } from './vitest.shared.mts'

// Vitest config used by Stryker's vitest-runner (`yarn test:mutation`).
//
// It mirrors the `unit` project of vitest.config.mts and nothing else:
//   - No coverage block. Mutants deliberately break the code, so line-coverage
//     thresholds are meaningless here — the mutation score is the metric.
//   - No `integration` project. Stryker re-runs the suite once per mutant; pointing that at
//     test/integration/*.itest.mts would hammer the real Redis cluster AND the real MongoDB
//     hundreds of times inside this service's own `marketplaceDev:itest:authenticatedAuthorization:`
//     namespace, where `fileParallelism: false` serialises everything. Unit tests mock both
//     datasources, so mutant runs stay hermetic and parallelisable.
//
// Keep the plugins/resolve/inline settings in sync with vitest.config.mts — the
// `.mjs -> .mts` NodeNext rewrite and the single-graphql-realm pinning are load
// bearing, not preferences.
const inlineDeps = [/graphql/, /@apollo\/server/, /@as-integrations/]

export default defineConfig({
	plugins: [nodeNextResolver],
	resolve: { dedupe: ['graphql'] },
	test: {
		include: ['test/*.test.mts'],
		server: { deps: { inline: inlineDeps } },
		testTimeout: 30_000,
		// Same as the `unit` project: set before the sources call `dotenv.config()`,
		// which does not override keys already present in process.env.
		env: {
			NODE_ENV: 'test',
			REDIS_KEY: 'test:',
			INTROSPECTION_CODE: 'test-introspection-code'
		}
	}
})
