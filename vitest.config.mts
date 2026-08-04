import { defineConfig } from 'vitest/config'

import { buildTestMongoUrl } from './vitest.mongo.mts'
import { nodeNextResolver } from './vitest.shared.mts'

// graphql throws "Duplicate graphql modules / from another realm" when a transformed copy
// (inlined by vitest) and a native copy (externalized in node_modules) meet — which happens
// the moment the real ApolloServer validates the schema. Inlining the whole graphql/Apollo
// chain keeps a single transformed instance across index.mts and Apollo. dedupe pins the path.
// koa-utils and marketplace-common must stay on the SAME side of this boundary. Both throw
// GraphQLErrors that koa-utils' tryCatchRethrow narrows with `instanceof`; split across the
// boundary they carry different graphql copies, the instanceof is false, and a 401 answers as
// 500 "Internal Server Error" — a failure that exists only under vitest, since plain node
// resolves both to one copy.
const inlineDeps = [
	/graphql/,
	/@apollo\/server/,
	/@as-integrations/,
	/@axiumine\/koa-utils/,
	/@thedoctorweb_agency\/marketplace-common/
]

// Two projects, one aggregated coverage report (must reach 100% — see COVERAGE.md):
//   - unit:        MongoDB/Redis mocked, fast, no datasource needed.
//   - integration: boots the real server against the real Redis cluster AND the real
//                  MongoDB (REDIS_* / MONGODB_URI from .env via the sources' own
//                  dotenv.config()); only the keyspace prefix is pinned to an isolated,
//                  ACL-allowed namespace and PORT=0 is ephemeral.
export default defineConfig({
	plugins: [nodeNextResolver],
	resolve: { dedupe: ['graphql'] },
	test: {
		server: { deps: { inline: inlineDeps } },
		coverage: {
			provider: 'v8',
			all: true,
			include: ['src/**/*.mts'],
			extension: ['.mts'],
			reporter: ['text', 'text-summary', 'html', 'lcov'],
			// 100% on every metric. If a run drops below, add tests or delete dead code until it
			// returns to 100% — never lower these numbers. See COVERAGE.md.
			thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 }
		},
		projects: [
			{
				plugins: [nodeNextResolver],
				resolve: { dedupe: ['graphql'] },
				test: {
					name: 'unit',
					include: ['test/*.test.mts'],
					server: { deps: { inline: inlineDeps } },
					// Set before the sources run `dotenv.config()` — dotenv does not override existing
					// process.env keys, so these win over whatever the local `.env` holds.
					env: {
						NODE_ENV: 'test',
						REDIS_KEY: 'test:',
						INTROSPECTION_CODE: 'test-introspection-code'
					}
				}
			},
			{
				plugins: [nodeNextResolver],
				resolve: { dedupe: ['graphql'] },
				test: {
					name: 'integration',
					include: ['test/integration/*.itest.mts'],
					server: { deps: { inline: inlineDeps } },
					// Drops and re-migrates the throwaway database as the DB owner before any test file
					// is imported, so every collection carries the real validators and indexes.
					globalSetup: ['./test/integration/globalSetup.mts'],
					// Redis connection params (hosts/user/password/cluster flag) come from .env; the overrides
					// below are pinned: per-service keyspace, ephemeral port, and the throwaway database reached
					// with the least-privilege R/W user.
					//
					// REDIS_KEY carries the service name as a third segment so all seven services' integration
					// suites can run at the same time. They used to share `marketplaceDev:itest:`, which meant a
					// platform-wide run had to be serialised: two suites at once see each other's session keys
					// and drain each other's cleanup lists. The `marketplaceDev:itest:` stem is kept because the
					// Redis ACL grants the test user exactly that pattern — a new top-level prefix would be
					// denied. `fileParallelism: false` below is a different axis and still required: files
					// inside one service share its throwaway database.
					env: {
						NODE_ENV: 'test',
						REDIS_KEY: 'marketplaceDev:itest:authenticatedAuthorization:',
						INTROSPECTION_CODE: 'test-introspection-code',
						PORT: '0',
						MONGODB_URI: buildTestMongoUrl('rw')
					},
					fileParallelism: false,
					testTimeout: 30000,
					hookTimeout: 30000
				}
			}
		]
	}
})
