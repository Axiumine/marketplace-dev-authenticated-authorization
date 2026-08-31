import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import net from 'node:net'

import { MongoDBConnect, MongoDBDisconnect } from '@axiumine/koa-utils/dataSources/MongoDB'
import { redisClient, RedisConnect } from '@axiumine/koa-utils/dataSources/Redis'
import { encryptDocument } from '@axiumine/marketplace-common/encryption/encryptDocument'
import { ENCRYPTED_FIELDS_SHOP_OWNER, KEY_ALT_NAME_SHOP_OWNER } from '@axiumine/marketplace-common/encryption/encryptedFields'
import { setupFieldEncryption } from '@axiumine/marketplace-common/encryption/setupFieldEncryption'
import { sessionKey } from '@axiumine/marketplace-common/others/sessionKeys'
import { TIER } from '@axiumine/marketplace-common/others/Tier'
import Keygrip from 'keygrip'
import mongoose from 'mongoose'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
	createServer,
	ENDPOINT,
	gracefulShutdown,
	logListening,
	onUncaughtException,
	onUnhandledRejection
} from '../../src/index.mts'
import { disconnectAllDatabases } from '../../src/lib/db/disconnectAllDatabases.mts'
import { ITEST_KEYGRIP_KEYS } from '../../vitest.keygrip.mts'

/*
 * The process-lifecycle half of the service, exercised against the real datasources.
 *
 * Everything here was previously unreachable from an integration test for one reason: it ends in
 * `process.exit()`. That is a tooling problem, not a "cannot be tested for real" problem — the exit
 * is the LAST statement of each path, so stubbing it lets the real work in front of it run against
 * the real Redis cluster and the real MongoDB and simply return instead of killing the runner.
 *
 * Nothing else is stubbed. `apolloServer.stop()` really drains, `httpServer.close()` really closes,
 * and `disconnectAllDatabases` really tears down both live connections — which is exactly why this
 * file lives on its own: vitest isolates each test file in its own module registry, so the
 * connections destroyed below are this file's, not the ones index.itest.mts is using.
 */

// Real handles for this file only. Rebuilt per test that needs them, because the point of most of
// them is to destroy the thing.
let exitSpy: ReturnType<typeof vi.spyOn>

// Unlike the public tier, this one gates EVERY route (including /health and the GraphQL endpoint
// itself) behind authenticatedAuthorizationHandler — it is mounted in createServer() before the
// path-based routing, not after. So any real HTTP round-trip below carries a whole account, even a
// request whose point has nothing to do with the session itself (e.g. asking whether introspection
// is refused).
const keys = new Keygrip(
	ITEST_KEYGRIP_KEYS.map((key) => key.material),
	'sha512'
)

function signedCookie(refresh: string): string {
	return `refresh_token=${refresh}; refresh_token.sig=${keys.sign(`refresh_token=${refresh}`)}`
}

/**
 * The credentials this service accepts, and the only ones: a signed refresh cookie whose session is on
 * the cluster and whose `_id` names a real shopOwner. Returns them alongside a `cleanup` that drops both
 * again — the drain tests below close the connections, so nothing seeded here can wait for `afterAll`.
 *
 * The document is the smallest one the collection's `$jsonSchema` accepts — `login` and `registeredAt`,
 * nothing else — because no personal field is read on this path. `login.email` still goes through
 * `encryptDocument` (ADR-029): the validator declares it `binData`, so a raw seed of plaintext is refused.
 */
async function seedAuthenticatedCaller() {
	const _id = new mongoose.Types.ObjectId()
	const email = `itest-${randomUUID()}@marketplace.invalid`

	await mongoose.connection
		.db!.collection('shopOwner')
		.insertOne(
			await encryptDocument(
				{ _id, login: { email, password: `$2y$14$${'x'.repeat(53)}` }, registeredAt: new Date() },
				ENCRYPTED_FIELDS_SHOP_OWNER,
				KEY_ALT_NAME_SHOP_OWNER
			)
		)

	const refresh = randomUUID()
	const refreshKey = sessionKey(`refresh:${refresh}`)
	await redisClient.hSet(refreshKey, {
		_id: _id.toHexString(),
		tier: TIER.shopOwner,
		familyId: randomUUID(),
		originalLogin: `${Date.now()}`,
		sessionCapDays: '30'
	})

	return {
		headers: { cookie: signedCookie(refresh) },
		cleanup: async () => {
			await redisClient.del(refreshKey).catch(() => undefined)
			await mongoose.connection
				.db!.collection('shopOwner')
				.deleteOne({ _id })
				.catch(() => undefined)
		}
	}
}

beforeAll(async () => {
	await Promise.all([MongoDBConnect(), RedisConnect()])
	// The seed below writes `login.email` as ciphertext, and nothing can encrypt until this has run.
	await setupFieldEncryption()
})

afterAll(async () => {
	// Best-effort: most tests below have already torn these down. RedisDisconnect swallows an
	// already-closed client, and mongoose.disconnect() on a disconnected mongoose is a no-op.
	await MongoDBDisconnect().catch(() => undefined)
	await redisClient.close().catch(() => undefined)
})

describe('production hardening actually applies to a real server', () => {
	/*
	 * buildValidationRules only returns NoSchemaIntrospectionCustomRule + depthLimit(10) under
	 * NODE_ENV=production, and every other test in every suite runs as `test`, so that arm had
	 * never been exercised. Asserted by booting a real production-mode server and asking it for its
	 * schema over real HTTP — a unit call to buildValidationRules() would only prove the array was
	 * built, not that Apollo enforces it.
	 */
	it('refuses introspection when booted as production', async () => {
		const realNodeEnv = process.env.NODE_ENV
		process.env.NODE_ENV = 'production'

		let server: Awaited<ReturnType<typeof createServer>> | undefined
		let caller: Awaited<ReturnType<typeof seedAuthenticatedCaller>> | undefined
		try {
			server = await createServer(ITEST_KEYGRIP_KEYS)
			// ⚠️ Restored the moment the server exists, and this is load-bearing rather than tidy.
			// `validationRules: buildValidationRules()` is evaluated once, inside createServer(), so the
			// introspection rule this test is about is already fixed on the running Apollo, while
			// everything the request still has to get through — the handler, the session read, the
			// account lookup — goes back to running the way the rest of this suite runs it. Booted as
			// production, called as test: exactly what the test name claims.
			process.env.NODE_ENV = realNodeEnv
			await new Promise<void>((resolve) => server!.httpServer.listen({ port: 0 }, () => resolve()))
			const { port } = server.httpServer.address() as AddressInfo

			// Every route on this service is behind the handler, so asking Apollo anything at all means
			// arriving with a session — there is no header that stands in for one.
			caller = await seedAuthenticatedCaller()

			const res = await fetch(`http://127.0.0.1:${port}${ENDPOINT}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...caller.headers },
				body: JSON.stringify({ query: '{ __schema { queryType { name } } }' })
			})
			const json = (await res.json()) as { data?: unknown; errors?: Array<{ message: string }> }

			expect(json.data).toBeUndefined()
			expect(json.errors?.[0]?.message).toMatch(/introspection/i)
		} finally {
			process.env.NODE_ENV = realNodeEnv
			await caller?.cleanup()
			if (server) {
				await server.apolloServer.stop()
				await new Promise<void>((resolve) => server!.httpServer.close(() => resolve()))
			}
		}
	})

	// The other NODE_ENV=production arm: the listening banner is mirrored to Sentry as an info
	// event. logListening takes its env as a parameter precisely so this can be driven without
	// re-entering the production branch above.
	it('mirrors the listening banner to Sentry under production', () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

		try {
			logListening({ ...process.env, NODE_ENV: 'production', PORT: '4029' })

			expect(info).toHaveBeenCalledWith(`Serving http://*:4029${ENDPOINT} for production.`)
		} finally {
			info.mockRestore()
		}
	})
})

describe('process-level error handlers', () => {
	beforeAll(() => {
		exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
	})

	it('exits 1 on an unhandled rejection', () => {
		onUnhandledRejection(new Error('itest unhandled rejection'))

		expect(exitSpy).toHaveBeenCalledWith(1)
	})

	it('exits 1 on an uncaught exception', () => {
		onUncaughtException(new Error('itest uncaught exception'))

		expect(exitSpy).toHaveBeenCalledWith(1)
	})
})

describe('gracefulShutdown against the real server and the real datasources', () => {
	/*
	 * The whole SIGTERM path in one go: Apollo drains, the HTTP server closes, and its close
	 * callback runs disconnectAllDatabases(0) — the success arm — which really disconnects mongoose
	 * and really closes the Redis cluster client. Asserted on the connections themselves, not on a
	 * spy call count, because the point is that the teardown actually happened.
	 */
	it('drains Apollo, closes the server, disconnects both datasources and exits 0', async () => {
		const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

		try {
			const { httpServer, apolloServer } = await createServer(ITEST_KEYGRIP_KEYS)
			await new Promise<void>((resolve) => httpServer.listen({ port: 0 }, () => resolve()))

			// Live before, so the assertions after mean something.
			expect((httpServer.address() as AddressInfo).port).toBeGreaterThan(0)
			expect(mongoose.connection.readyState).toBe(1)
			expect(redisClient.isOpen).toBe(true)

			await gracefulShutdown('SIGTERM', apolloServer, httpServer)

			// gracefulShutdown fires disconnectAllDatabases from the close callback and does not
			// await it, so wait for the real teardown to land rather than racing it.
			await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 15000 })

			expect(httpServer.listening).toBe(false)
			expect(mongoose.connection.readyState).toBe(0)
			expect(redisClient.isOpen).toBe(false)
		} finally {
			exit.mockRestore()
		}
	})
})

describe('disconnectAllDatabases called again once everything is already down', () => {
	// RedisDisconnect swallows "The client is closed" by design and mongoose.disconnect() is a
	// no-op when already disconnected, so a second call still takes the success arm and exits with
	// the code it was given. This pins that a repeated shutdown signal cannot turn into a failure.
	it('still takes the success arm and honours a non-zero exit code', async () => {
		const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

		try {
			await disconnectAllDatabases(3)

			expect(exit).toHaveBeenCalledWith(3)
		} finally {
			exit.mockRestore()
		}
	})
})

describe('disconnectAllDatabases when the teardown cannot finish in time', () => {
	/*
	 * The 5-second race in disconnectAllDatabases, lost for real — nothing is stubbed or faked.
	 *
	 * The trigger is a genuine production shape: a shutdown signal arriving while a MongoDB
	 * connection attempt is still in flight. mongoose.disconnect() will not return until that
	 * attempt settles, so the race's timeout fires first and the catch arm runs.
	 *
	 * The unreachable server is a local socket that accepts the TCP connection and then never
	 * speaks, so the driver hangs on the handshake until its own 8s server-selection timeout. That
	 * is deliberately longer than the 5s budget and deliberately local: pointing at an off-machine
	 * blackhole address would make the timing depend on how the network drops packets.
	 */
	it('exits 1 rather than the requested code when the 5s budget runs out', async () => {
		const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
		// Kept so the finally can destroy them: net.Server has no closeAllConnections() (that is
		// http.Server), and close() on its own waits for open sockets that will never end here.
		const sockets: net.Socket[] = []
		const blackhole = net.createServer((socket) => void sockets.push(socket))
		let pending: Promise<unknown> = Promise.resolve()

		try {
			await new Promise<void>((resolve) => blackhole.listen(0, '127.0.0.1', () => resolve()))
			const { port } = blackhole.address() as AddressInfo

			pending = mongoose
				.connect(`mongodb://127.0.0.1:${port}/itest-unreachable`, {
					serverSelectionTimeoutMS: 8000,
					connectTimeoutMS: 8000,
					family: 4
				})
				.catch(() => undefined)

			// 0 is requested, but the catch arm hardcodes 1 — a failed teardown must not be able to
			// report success to whatever supervises the process.
			await disconnectAllDatabases(0)

			expect(exit).toHaveBeenCalledWith(1)
			expect(exit).not.toHaveBeenCalledWith(0)
		} finally {
			exit.mockRestore()
			// Destroying the sockets first is not optional: close() waits for open ones, and the
			// driver's is still open by design here, so the callback would never fire. Killing it
			// also makes the in-flight attempt give up at once instead of sitting out its full 8s
			// server-selection timeout.
			for (const socket of sockets) socket.destroy()
			await new Promise<void>((resolve) => blackhole.close(() => resolve()))
			// Awaited last, so no attempt outlives the test.
			await pending
		}
	})
})
