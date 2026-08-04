import { graphql, GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLSchema, GraphQLString } from 'graphql'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// MutationsApi pulls in the refresh resolver, which imports the Redis datasource at module load.
// This file only asserts schema shape, so the client is stubbed rather than instantiated.
vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient: {} }))

// Imported dynamically inside beforeAll rather than at module top: these are module-level
// GraphQLObjectType/field literals, built once when each module first loads. A top-level
// `import` runs during Vitest's file-collection phase, before any test executes — a mutant
// that changes one of these literals (or makes the constructor throw, e.g. dropping `name`)
// then takes effect during collection itself, so Stryker cannot attribute the failure to any
// test and reports the mutant as Survived even though the suite would plainly notice. Loading
// the modules inside beforeAll makes that load happen inside the test run instead.
//
// The try/catch matters just as much as the dynamic import: a mutant that makes the
// GraphQLObjectType constructor throw (an emptied fields object, a blanked-out name) would
// otherwise make this hook itself throw, and Vitest treats a throwing beforeAll as the whole
// file failing to run — every `it` in it is reported "skipped", not "failed", and a run with
// no failing (and no passing) test gives Stryker nothing to attribute the kill to, so the
// mutant is reported Survived despite the code visibly crashing. Swallowing the error here
// leaves the corresponding binding undefined instead, so each assertion below that touches it
// fails on its own, as a normal per-test failure Stryker can attribute.
let MutationsApi: (typeof import('../src/graphQLApi/schema/mutations.mts'))['default']
let QueriesApi: (typeof import('../src/graphQLApi/schema/queries.mts'))['default']
let helloRefresh: (typeof import('../src/graphQLApi/schema/queries/helloRefresh.mts'))['helloRefresh']
let Hello2Type: (typeof import('../src/graphQLApi/schema/types/Hello2Type.mts'))['default']
let RefreshType: (typeof import('../src/graphQLApi/schema/types/RefreshType.mts'))['RefreshType']

beforeAll(async () => {
	try {
		;({ default: MutationsApi } = await import('../src/graphQLApi/schema/mutations.mts'))
		;({ default: QueriesApi } = await import('../src/graphQLApi/schema/queries.mts'))
		;({ helloRefresh } = await import('../src/graphQLApi/schema/queries/helloRefresh.mts'))
		;({ default: Hello2Type } = await import('../src/graphQLApi/schema/types/Hello2Type.mts'))
		;({ RefreshType } = await import('../src/graphQLApi/schema/types/RefreshType.mts'))
	} catch {
		// Deliberately swallowed — see comment above. Whichever binding never got assigned
		// stays undefined, and the tests that dereference it fail with their own error instead
		// of the whole file being marked skipped.
	}
})

describe('Hello2Type', () => {
	it('exposes only the txt field, a non-nullable String', () => {
		const fields = Hello2Type.getFields()

		expect(Hello2Type.name).toBe('Hello2Type')
		expect(Object.keys(fields)).toEqual(['txt'])
		expect(fields.txt.type).toBeInstanceOf(GraphQLNonNull)
		expect((fields.txt.type as GraphQLNonNull<typeof GraphQLString>).ofType).toBe(GraphQLString)
	})
})

describe('RefreshType', () => {
	it('exposes a non-nullable status and accessToken', () => {
		const fields = RefreshType.getFields()

		expect(RefreshType.name).toBe('RefreshType')
		expect(Object.keys(fields)).toEqual(['status', 'accessToken'])
		expect((fields.status.type as GraphQLNonNull<typeof GraphQLBoolean>).ofType).toBe(GraphQLBoolean)
		expect((fields.accessToken.type as GraphQLNonNull<typeof GraphQLString>).ofType).toBe(GraphQLString)
	})
})

describe('queries.helloRefresh', () => {
	it('is of non-nullable Hello2Type', () => {
		expect(helloRefresh.description).toBe('helloRefresh')
		expect(helloRefresh.type).toBeInstanceOf(GraphQLNonNull)
		expect((helloRefresh.type as GraphQLNonNull<GraphQLObjectType>).ofType).toBe(Hello2Type)
	})

	it('resolves the greeting text', () => {
		expect(helloRefresh.resolve()).toEqual({ txt: 'Hello from helloRefresh' })
	})
})

describe('QueriesApi', () => {
	it('mounts helloRefresh as its only field', () => {
		expect(QueriesApi.name).toBe('QueriesApi')
		expect(Object.keys(QueriesApi.getFields())).toEqual(['helloRefresh'])
	})

	it('runs the query end-to-end', async () => {
		const result = await graphql({
			schema: new GraphQLSchema({ query: QueriesApi }),
			source: '{ helloRefresh { txt } }'
		})

		expect(result.errors).toBeUndefined()
		expect(result.data).toEqual({ helloRefresh: { txt: 'Hello from helloRefresh' } })
	})
})

describe('MutationsApi', () => {
	it('mounts refresh as its only field, of non-nullable RefreshType', () => {
		const fields = MutationsApi.getFields()

		expect(MutationsApi.name).toBe('MutationsApi')
		expect(Object.keys(fields)).toEqual(['refresh'])
		expect(fields.refresh.description).toBe('refresh token')
		expect((fields.refresh.type as GraphQLNonNull<GraphQLObjectType>).ofType).toBe(RefreshType)
	})
})
