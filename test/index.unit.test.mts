import http from 'node:http'

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const captureException = vi.fn()
const captureMessage = vi.fn()
const RedisConnect = vi.fn()
const MongoDBConnect = vi.fn()
const disconnectAllDatabases = vi.fn()
const setupFieldEncryption = vi.fn()

vi.mock('@sentry/node', () => ({ captureException, captureMessage }))
// redisClient is imported transitively by the handler / resolvers; a bare stub is enough
// because the unit project never connects — only start()'s failure path is exercised here.
vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ RedisConnect, redisClient: {} }))
vi.mock('@axiumine/koa-utils/dataSources/MongoDB', () => ({ MongoDBConnect }))
// Mocked because the real one opens a ClientEncryption against a live cluster and reads a 96-byte
// key file off disk (ADR-029) — neither exists in the unit project. What start() owes it is that it
// is awaited and that its rejection lands in the same catch as a datasource failure, and both are
// asserted below.
vi.mock('@axiumine/marketplace-common/encryption/setupFieldEncryption', () => ({ setupFieldEncryption }))
vi.mock('@lib/db/disconnectAllDatabases.mjs', () => ({ disconnectAllDatabases }))

// Imported dynamically inside beforeAll, not with a top-level `await import`: src/index.mts
// statically imports mutations.mts/queries.mts (for the schema it builds), so a top-level
// import here — even the `await import(...)` form — still runs during Vitest's file-collection
// phase, before any test executes, and its result is the module the entire unit project's
// worker process then keeps reusing. A mutant that changes one of those module-level GraphQL
// literals takes effect during that collection-time evaluation, so Stryker cannot attribute the
// change to any test and reports it Survived. Loading src/index.mts inside beforeAll instead
// makes the whole chain evaluate inside the test run.
//
// The try/catch matters just as much as the dynamic import: a mutant that makes a nested
// GraphQLObjectType constructor throw (mutations.mts/queries.mts, imported transitively) would
// otherwise make this hook itself throw, and Vitest treats a throwing beforeAll as the whole
// file failing to run — every `it` below is reported "skipped", not "failed", and a run with no
// failing (and no passing) test gives Stryker nothing to attribute the kill to, so the mutant is
// reported Survived despite the code visibly crashing. Swallowing the error here leaves every
// binding below undefined instead, so each test that dereferences one fails on its own, as a
// normal per-test failure Stryker can attribute.
let ENDPOINT: (typeof import('../src/index.mts'))['ENDPOINT']
let REQUIRED_ENV_VARS: (typeof import('../src/index.mts'))['REQUIRED_ENV_VARS']
let checkRequiredEnv: (typeof import('../src/index.mts'))['checkRequiredEnv']
let buildValidationRules: (typeof import('../src/index.mts'))['buildValidationRules']
let healthResponse: (typeof import('../src/index.mts'))['healthResponse']
let logListening: (typeof import('../src/index.mts'))['logListening']
let gracefulShutdown: (typeof import('../src/index.mts'))['gracefulShutdown']
let onUnhandledRejection: (typeof import('../src/index.mts'))['onUnhandledRejection']
let onUncaughtException: (typeof import('../src/index.mts'))['onUncaughtException']
let start: (typeof import('../src/index.mts'))['start']

beforeAll(async () => {
	try {
		;({
			ENDPOINT,
			REQUIRED_ENV_VARS,
			checkRequiredEnv,
			buildValidationRules,
			healthResponse,
			logListening,
			gracefulShutdown,
			onUnhandledRejection,
			onUncaughtException,
			start
		} = await import('../src/index.mts'))
	} catch {
		// Deliberately swallowed — see comment above.
	}
})

describe('checkRequiredEnv', () => {
	it('passes when every required variable is set', () => {
		const env = Object.fromEntries(REQUIRED_ENV_VARS.map((k) => [k, 'x']))
		expect(() => checkRequiredEnv(env)).not.toThrow()
	})

	it('throws naming the first missing variable', () => {
		expect(() => checkRequiredEnv({})).toThrow(`Missing required environment variable: ${REQUIRED_ENV_VARS[0]}`)
	})

	/*
	 * Both entries named as literals, because the two tests above cannot see WHICH names the list
	 * carries: the first builds its passing environment out of the list itself, so a corrupted entry
	 * is satisfied by the very stub the corruption produced, and the second only ever reads
	 * REQUIRED_ENV_VARS[0].
	 *
	 * MONGODB_URI — start() calls MongoDBConnect(), so without the guard a missing URI surfaces as a
	 * driver error from inside the try, reported to Sentry and exited 1, instead of one line before
	 * anything connects.
	 * INTROSPECTION_CODE — the service-to-service bypass compares the header against
	 * `${process.env.INTROSPECTION_CODE}`, which stringifies an unset value to 'undefined' and admits
	 * any caller sending that literal string.
	 */
	it('requires MONGODB_URI and INTROSPECTION_CODE by name', () => {
		expect(REQUIRED_ENV_VARS).toContain('MONGODB_URI')
		expect(REQUIRED_ENV_VARS).toContain('INTROSPECTION_CODE')
	})
})

describe('buildValidationRules', () => {
	it('is empty outside production', () => {
		expect(buildValidationRules({ NODE_ENV: 'test' })).toEqual([])
	})

	it('caps depth and blocks introspection in production', () => {
		expect(buildValidationRules({ NODE_ENV: 'production' })).toHaveLength(2)
	})
})

describe('healthResponse', () => {
	it('reports OK with a round-trippable ISO timestamp', () => {
		const res = healthResponse()
		expect(res.status).toBe('OK')
		expect(res.timestamp).toBe(new Date(res.timestamp).toISOString())
	})
})

describe('logListening', () => {
	let info: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		captureMessage.mockReset()
		info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
	})
	afterEach(() => {
		info.mockRestore()
		vi.unstubAllEnvs()
	})

	// The real call site (start(), see below) invokes logListening() with NO arguments at all,
	// falling back to process.env — it never passes an explicit env object. A test that only
	// exercises the explicit-argument form can pass while the production path prints "undefined"
	// for a value process.env genuinely lacks (this happened: HOSTNAME was removed from the env
	// template and REQUIRED_ENV_VARS, but logListening used to still read env.HOSTNAME). These two
	// tests stub process.env and call logListening() with zero arguments, matching start() exactly.
	it('with no arguments, logs the exact banner built from process.env outside production', () => {
		vi.stubEnv('NODE_ENV', 'test')
		vi.stubEnv('PORT', '4029')

		logListening()

		expect(info).toHaveBeenCalledExactlyOnceWith(`Serving http://*:4029${ENDPOINT} for test.`)
		expect(captureMessage).not.toHaveBeenCalled()
	})

	it('with no arguments, also mirrors the exact banner to Sentry in production', () => {
		vi.stubEnv('NODE_ENV', 'production')
		vi.stubEnv('PORT', '80')

		logListening()

		const expected = `Serving http://*:80${ENDPOINT} for production.`
		expect(captureMessage).toHaveBeenCalledExactlyOnceWith(expected, 'info')
		expect(info).toHaveBeenCalledExactlyOnceWith(expected)
	})

	it('logs to the console only, outside production', () => {
		logListening({ NODE_ENV: 'test', PORT: '4029' })
		expect(info).toHaveBeenCalledExactlyOnceWith(`Serving http://*:4029${ENDPOINT} for test.`)
		expect(captureMessage).not.toHaveBeenCalled()
	})

	it('also mirrors the banner to Sentry in production, naming no single host', () => {
		logListening({ NODE_ENV: 'production', PORT: '80' })
		// The `*` stands in for the address: the server binds every interface, so there is no
		// single host to print.
		const expected = `Serving http://*:80${ENDPOINT} for production.`
		expect(captureMessage).toHaveBeenCalledExactlyOnceWith(expected, 'info')
		expect(info).toHaveBeenCalledExactlyOnceWith(expected)
	})
})

describe('gracefulShutdown', () => {
	beforeEach(() => {
		captureMessage.mockReset()
		disconnectAllDatabases.mockReset()
	})

	it('drains Apollo, closes the server and disconnects with code 0', async () => {
		const apolloServer = { stop: vi.fn().mockResolvedValue(undefined) }
		const httpServer = { close: vi.fn((cb: () => void) => cb()) }

		await gracefulShutdown('SIGTERM', apolloServer as never, httpServer as never)

		expect(captureMessage).toHaveBeenCalledWith('SIGTERM received, shutting down gracefully...')
		expect(apolloServer.stop).toHaveBeenCalledTimes(1)
		expect(disconnectAllDatabases).toHaveBeenCalledWith(0)
	})
})

describe('process handlers', () => {
	let exit: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		captureException.mockReset()
		exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
	})
	afterEach(() => exit.mockRestore())

	it('onUnhandledRejection reports the reason and exits 1', () => {
		const reason = new Error('boom')
		onUnhandledRejection(reason)
		expect(captureException).toHaveBeenCalledWith(reason)
		expect(exit).toHaveBeenCalledWith(1)
	})

	it('onUncaughtException reports the error and exits 1', () => {
		const error = new Error('kaboom')
		onUncaughtException(error)
		expect(captureException).toHaveBeenCalledWith(error)
		expect(exit).toHaveBeenCalledWith(1)
	})
})

describe('start (failure path)', () => {
	let errorLog: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		captureException.mockReset()
		disconnectAllDatabases.mockReset()
		RedisConnect.mockReset()
		MongoDBConnect.mockReset().mockResolvedValue(undefined)
		setupFieldEncryption.mockReset().mockResolvedValue(undefined)
		for (const k of REQUIRED_ENV_VARS) vi.stubEnv(k, 'x')
		errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})
	afterEach(() => {
		errorLog.mockRestore()
		vi.unstubAllEnvs()
	})

	it('reports to Sentry and disconnects with code 1 when Redis fails to connect', async () => {
		const error = new Error('redis boom')
		RedisConnect.mockRejectedValueOnce(error)

		await start()

		expect(RedisConnect).toHaveBeenCalledTimes(1)
		expect(captureException).toHaveBeenCalledWith(error)
		expect(disconnectAllDatabases).toHaveBeenCalledWith(1)
	})

	// Both datasources are opened by the same Promise.all, so MongoDB's rejection has to be
	// covered separately — Redis resolving is not enough to prove the catch handles either side.
	it('reports to Sentry and disconnects with code 1 when MongoDB fails to connect', async () => {
		const error = new Error('mongo boom')
		RedisConnect.mockResolvedValueOnce(undefined)
		MongoDBConnect.mockRejectedValueOnce(error)

		await start()

		expect(captureException).toHaveBeenCalledWith(error)
		expect(disconnectAllDatabases).toHaveBeenCalledWith(1)
	})

	// A service that came up with field encryption broken would answer queries with ciphertext and
	// write plaintext beside it, so this failure has to be as fatal as a datasource failure.
	it('reports to Sentry and disconnects with code 1 when field encryption cannot start', async () => {
		const error = new Error('CSFLE_MASTER_KEY_PATH is not set — field encryption cannot start without it')
		setupFieldEncryption.mockRejectedValueOnce(error)

		await start()

		expect(setupFieldEncryption).toHaveBeenCalledTimes(1)
		expect(captureException).toHaveBeenCalledWith(error)
		expect(disconnectAllDatabases).toHaveBeenCalledWith(1)
	})
})

describe('start (success path)', () => {
	let listenSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		captureException.mockReset()
		RedisConnect.mockReset().mockResolvedValue(undefined)
		MongoDBConnect.mockReset().mockResolvedValue(undefined)
		setupFieldEncryption.mockReset().mockResolvedValue(undefined)
		for (const k of REQUIRED_ENV_VARS) vi.stubEnv(k, 'x')
		// listen() itself is stubbed out below, so PORT can stay the same placeholder as every
		// other required var — no socket is ever really opened by this test.
		listenSpy = vi.spyOn(http.Server.prototype, 'listen').mockImplementation(function (this: http.Server, ...args: unknown[]) {
			const callback = args.find((arg): arg is () => void => typeof arg === 'function')
			callback?.()

			return this
		})
	})
	afterEach(() => {
		listenSpy.mockRestore()
		vi.unstubAllEnvs()
	})

	it('passes only { port }, never a host, to listen — binding every interface on purpose', async () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

		const server = await start()

		// The whole point of the fix this asserts: no `host`/`hostname` key travels into listen()
		// at all. Node silently ignores an unrecognised option, so a regression here would not
		// throw — this exact-shape check is the only thing that would catch it, and it is also
		// what kills mutants on this call (a mutated options object would fail the match).
		expect(listenSpy).toHaveBeenCalledExactlyOnceWith({ port: process.env.PORT }, expect.any(Function))
		// Once, with no arguments: it reads its configuration from the environment, and a caller that
		// passed it anything would be building a second source of truth for the master key path.
		expect(setupFieldEncryption).toHaveBeenCalledExactlyOnceWith()

		await server?.apolloServer.stop()
		info.mockRestore()
	})
})
