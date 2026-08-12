import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'

import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { REFRESH_TOKEN_EXPIRY } from '@axiumine/koa-utils/lib/tokens'
import { encryptDocument } from '@axiumine/marketplace-common/encryption/encryptDocument'
import { ENCRYPTED_FIELDS_SHOP_OWNER, KEY_ALT_NAME_SHOP_OWNER } from '@axiumine/marketplace-common/encryption/encryptedFields'
import { familyKey, sessionKey, tombstoneKey } from '@axiumine/marketplace-common/others/sessionKeys'
import { TIER } from '@axiumine/marketplace-common/others/Tier'
import * as dotenv from 'dotenv'
import type { Server } from 'http'
import Keygrip from 'keygrip'
import mongoose from 'mongoose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The sources call dotenv.config() transitively (MongoDB/Redis datasources, handler); this is a
// belt-and-suspenders load so KEYGRIP_KEY_* are present when this file's top level reads them.
dotenv.config()

import { ENDPOINT, start } from '../../src/index.mts'

const REDIS_KEY = process.env.REDIS_KEY as string
const INTROSPECTION_CODE = process.env.INTROSPECTION_CODE as string

// accessTokenExpiry() returns floor((random() * 61 + 30) * 60) — a random 30-to-91-minute
// window — so the access TTL can only be asserted as a range. REFRESH_TOKEN_EXPIRY is fixed.
const ACCESS_TTL_MIN = 1800
const ACCESS_TTL_MAX = 5459

// Nothing on this tier ever verifies a password — there is no login here — so a seeded hash
// only has to satisfy the validator's exactly-60-characters rule.
const PASSWORD_HASH = `$2y$14$${'x'.repeat(53)}`
// Must match the server's cookie signer exactly (see createServer): same keys, same SHA-512.
const keys = new Keygrip([process.env.KEYGRIP_KEY_1 as string, process.env.KEYGRIP_KEY_2 as string], 'sha512')

// A refresh cookie the way Koa emits it: the value plus its `.sig` Keygrip signature.
function signedCookie(refresh: string): string {
	return `refresh_token=${refresh}; refresh_token.sig=${keys.sign(`refresh_token=${refresh}`)}`
}

// The introspection code is NOT a substitute for the cookie: verifySignedRefreshToken runs first
// and rejects a request with no cookie before the code is ever read. The bypass only rescues a
// correctly signed cookie whose Redis session no longer exists — so service-to-service calls send
// both. Every headers object below reflects that ordering.
function bypassHeaders() {
	return { cookie: signedCookie(randomUUID()), 'x-introspectioncode': INTROSPECTION_CODE }
}

let httpServer: Server
let base: string

/** POST a GraphQL document to the real endpoint and return status + parsed body. */
async function gql(query: string, headers: Record<string, string> = {}) {
	const res = await fetch(`${base}${ENDPOINT}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify({ query })
	})

	return {
		status: res.status,
		// refresh re-issues the cookie through setLoginCookies; the rotation test reads the new
		// token back out of here, because it is never returned in the GraphQL payload.
		setCookie: res.headers.getSetCookie(),
		// tdwKoaErrorHandler answers rejected requests with {message, description}; Apollo answers
		// accepted ones with {data, errors}. One parse covers both shapes.
		json: (await res.json()) as {
			data?: Record<string, unknown>
			errors?: Array<{ message: string }>
			message?: string
			description?: string
		}
	}
}

/****************************************************************************************
 * Seeds. The rotation tests need the handler's MongoDB lookup to succeed, so they write a
 * real shopOwner to the dev database. Every document carries an `itest-…@marketplace.invalid`
 * address and is deleted again in afterAll, as is every session key they leave on the cluster.
 ****************************************************************************************/

const seededIds: mongoose.Types.ObjectId[] = []
const seededKeys: string[] = []

/** The raw driver handle — only defined once start() has connected. */
function db() {
	return mongoose.connection.db!
}

/** Remember a session key so afterAll removes it even if the test that created it fails. */
function track(key: string) {
	seededKeys.push(key)

	return key
}

/**
 * Inserted with the raw driver rather than the Mongoose model, the platform seeding convention:
 * the insert is then shaped by the collection's own `$jsonSchema` and by nothing else, so a seed
 * cannot inherit whatever the model happens to believe today. That is not hypothetical — the model
 * used to spell `personalData.birth.date` as `date` and carry no `contacts` path at all, both of
 * which the validator refuses under `additionalProperties: false`, so a model write failed outright
 * (fixed in marketplace-common 1.17.0). The raw path was never affected, and will not be by the next
 * drift either.
 *
 * `top` carries top-level fields the validator also accepts (`deleted`, `disabled`,
 * `waitApprov`) — the state-gate tests seed a real document in each of those states so
 * `checkUserAuthorizationDisDel` (marketplace-common, unmocked) runs against real data instead of a
 * fixture object.
 *
 * ⚠️ The personal fields go through `encryptDocument` first (ADR-029): the collection declares them
 * `binData`, so a raw seed of plaintext is refused by the validator. It runs after both override
 * bags are spread, so a caller adding an encrypted path gets its value encrypted too — `deleted`,
 * `disabled` and `waitApprov` are not personal data and stay in the clear.
 */
async function seedShopOwner(login: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
	const email = `itest-${randomUUID()}@marketplace.invalid`
	const _id = new mongoose.Types.ObjectId()

	await db()
		.collection('shopOwner')
		.insertOne(
			await encryptDocument(
				{
					_id,
					login: { email, password: PASSWORD_HASH, ...login },
					personalData: {
						firstName: 'Itest',
						lastName: 'ShopOwner',
						birth: { date: new Date('1980-01-01T00:00:00Z') },
						address: { street: '1 Test Street', postalCode: '01103', city: 'Springfield', province: 'MA' },
						contacts: { mobile: '3900000000', email }
					},
					registeredAt: new Date(),
					...top
				},
				ENCRYPTED_FIELDS_SHOP_OWNER,
				KEY_ALT_NAME_SHOP_OWNER
			)
		)
	seededIds.push(_id)

	return { _id, email }
}

/**
 * Register a session key and point it at a seeded shopOwner, the way a real login would.
 *
 * ⚠️ `tier` is part of "the way a real login would": `setRedisLoginSessionShopOwner` writes it, and
 * the handler calls `assertTier` on it before the MongoDB lookup. A seed without one is refused with
 * 403 — correctly, since a missing tier is invalid rather than a wildcard — so every test past the
 * gate would fail for a reason that has nothing to do with what it asserts.
 */
async function seedSession(_id: mongoose.Types.ObjectId, lineage = sessionLineage()) {
	const refresh = randomUUID()
	const refreshKey = track(sessionKey(`refresh:${refresh}`))
	await redisClient.hSet(refreshKey, { _id: _id.toHexString(), tier: TIER.shopOwner, ...lineage })

	return refresh
}

/**
 * The three lineage fields a real login stamps (E14-S01), and which `assertRefreshLineage` refuses a
 * session without — so, exactly like `tier` above, a seed missing them is refused at the guard and
 * every test past it would fail for a reason unrelated to what it asserts.
 *
 * The defaults describe a session opened just now with "remember me" ticked: thirty days of rotations
 * ahead of it, so nothing in this file trips the absolute cap by accident. The cap test overrides both.
 */
function sessionLineage(over: Record<string, string> = {}) {
	return { familyId: randomUUID(), originalLogin: `${Date.now()}`, sessionCapDays: '30', ...over }
}

/** The refresh token Koa just set, read back out of the Set-Cookie headers. */
function refreshTokenFrom(setCookie: string[]) {
	const header = setCookie.find((cookie) => cookie.startsWith('refresh_token='))
	if (!header) throw new Error('refresh did not set a refresh_token cookie')

	return header.slice('refresh_token='.length).split(';')[0]
}

beforeAll(async () => {
	const server = await start()
	if (!server) throw new Error('server failed to start against the real Redis cluster / MongoDB')
	httpServer = server.httpServer
	const address = httpServer.address() as AddressInfo | null
	if (!address || typeof address === 'string') throw new Error('no TCP address on the booted server')
	base = `http://127.0.0.1:${address.port}`
})

/**
 * Cleanup must never abort halfway. `afterAll` drains MongoDB first and Redis second, so a single
 * failed delete — a cluster MOVED mid-resharding, a handle closed early — would otherwise strand
 * every id and key registered after it, and would skip the Redis drain entirely. Mongo residue is
 * harmless, globalSetup drops and re-migrates the database on the next run; a stranded Redis key
 * sits in the cluster for its whole TTL, which for a refresh session is 90 days.
 */
async function drainSafely(what: string, remove: () => Promise<unknown>) {
	try {
		await remove()
	} catch (error) {
		console.error(`[afterAll] cleanup failed for ${what}:`, error)
	}
}

afterAll(async () => {
	// Drop whatever this run created while the handles are still open: documents first, then
	// any session key. One del per key — this is a cluster, so a multi-key del would CROSSSLOT.
	for (const _id of seededIds) {
		await drainSafely(`shopOwner ${_id.toString()}`, () => db().collection('shopOwner').deleteOne({ _id }))
	}
	for (const key of seededKeys) {
		await drainSafely(key, () => redisClient.del(key))
	}

	await new Promise<void>((resolve) => httpServer.close(() => resolve()))
	await redisClient.close()
	await mongoose.disconnect()
})

describe('authenticated-authorization service (integration, real MongoDB + real Redis cluster)', () => {
	// start() is what wires both datasources; asserting the live handles is what makes the rest of
	// this file an integration suite rather than an in-process schema test.
	it('has a live MongoDB connection', () => {
		expect(mongoose.connection.readyState).toBe(1)
	})

	it('has a live Redis cluster connection, round-tripping a key in the isolated namespace', async () => {
		const key = `${REDIS_KEY}ping:${randomUUID()}`

		// EX so this one cannot outlive the run. It is never registered for the afterAll drain, so
		// without a TTL a hard kill — or a throw on the assertion below — strands it on the cluster
		// forever. 60s is far longer than the round trip and short enough to be self-cleaning.
		await redisClient.set(key, 'pong', { EX: 60 })
		expect(await redisClient.get(key)).toBe('pong')

		await redisClient.del(key)
		expect(await redisClient.get(key)).toBeNull()
	})
})

describe('refresh-cookie gate over HTTP', () => {
	it('answers 412 when the request carries no cookie at all', async () => {
		const { status, json } = await gql('{ helloRefresh { txt } }')

		expect(status).toBe(412)
		expect(json.message).toBe('Precondition Failed')
	})

	it('answers 401 when the Keygrip signature does not verify (tampered cookie)', async () => {
		const { status, json } = await gql('{ helloRefresh { txt } }', {
			cookie: `refresh_token=${randomUUID()}; refresh_token.sig=forged`
		})

		expect(status).toBe(401)
		expect(json.message).toBe('Unauthorized')
	})

	// A cookie header that never carried a refresh_token at all — distinct from the empty-header
	// 412 above (verifySignedRefreshToken reads a defined cookie string here, then finds no
	// refresh_token key in it) and from the forged-signature 401 below.
	it('answers 499 when the cookie header carries no refresh_token key', async () => {
		const { status, json } = await gql('{ helloRefresh { txt } }', { cookie: 'unrelated=value' })

		expect(status).toBe(499)
		expect(json.message).toBe('Token Required')
		expect(json.description).toBe('Refresh Token Required.')
	})

	// An unsigned cookie: refresh_token is present but its .sig sibling never was. This is a
	// different branch of verifySignedRefreshToken than the forged-signature case above — that one
	// reaches the Keygrip index() check, this one never does because there is no signature to check.
	it('answers 499 when the refresh_token cookie carries no signature (unsigned cookie)', async () => {
		const { status, json } = await gql('{ helloRefresh { txt } }', { cookie: `refresh_token=${randomUUID()}` })

		expect(status).toBe(499)
		expect(json.message).toBe('Token Required')
		expect(json.description).toBe('Refresh Token Signature Required.')
	})

	it('answers 498 when the signature is good but the session is gone from Redis', async () => {
		const { status, json } = await gql('{ helloRefresh { txt } }', { cookie: signedCookie(randomUUID()) })

		expect(status).toBe(498)
		expect(json.message).toBe('Invalid Token')
	})

	// The session really exists on the cluster, so the request gets past Redis and dies in MongoDB:
	// the _id it points at matches no shopOwner. This is the one case that exercises both
	// datasources in a single request, which no unit test can do.
	it('answers 401 when the live session points at an shopOwner MongoDB does not have', async () => {
		const refresh = randomUUID()
		const refreshKey = sessionKey(`refresh:${refresh}`)
		// Correct tier, so the request really does reach MongoDB and die there — a tier-less seed
		// would answer 403 at the guard and prove nothing about the lookup this test is about.
		await redisClient.hSet(refreshKey, {
			_id: new mongoose.Types.ObjectId().toHexString(),
			tier: TIER.shopOwner,
			...sessionLineage()
		})

		try {
			const { status, json } = await gql('{ helloRefresh { txt } }', { cookie: signedCookie(refresh) })

			expect(status).toBe(401)
			expect(json.message).toBe('Unauthorized')
		} finally {
			await redisClient.del(refreshKey)
		}
	})
})

// The shopOwner-missing case above proves the Mongo round-trip on a miss. These prove it on a
// hit: a real document exists, and checkUserAuthorizationDisDel (marketplace-common, unmocked here)
// runs against its real deleted/disabled/waitApprov fields rather than a fixture object built by
// hand. Only the raw driver can put a document in each of these states past the real validator.
describe('shopOwner state gates against the real collection', () => {
	it('answers 401 when the live session points at an shopOwner that was deleted', async () => {
		const { _id } = await seedShopOwner({}, { deleted: new Date() })
		const refresh = await seedSession(_id)

		const { status, json } = await gql('{ helloRefresh { txt } }', { cookie: signedCookie(refresh) })

		expect(status).toBe(401)
		expect(json.message).toBe('Unauthorized')
	})

	it('answers 401 when the live session points at an shopOwner that is disabled', async () => {
		const { _id } = await seedShopOwner({}, { disabled: true })
		const refresh = await seedSession(_id)

		const { status, json } = await gql('{ helloRefresh { txt } }', { cookie: signedCookie(refresh) })

		expect(status).toBe(401)
		expect(json.message).toBe('Unauthorized')
	})

	// waitApprov is the manual-approval gate documented in the workspace CLAUDE.md, but
	// checkUserAuthorizationDisDel only reads `deleted` and `disabled` — this tier never checks it.
	// Proving that requires a real waitApprov:true document reaching the real gate function and
	// coming back through: a mock of checkUserAuthorizationDisDel could not tell us whether the
	// real one looks at the field or not.
	it('does not gate on waitApprov: a live session for an shopOwner awaiting approval still succeeds', async () => {
		// The one place in this repo that names the field on purpose. E01-S10's `no-restricted-syntax`
		// entry keeps `waitApprov` out of every service that must not read it, and a fixture is the
		// single shape that has to name it anyway — a rule that refused this line would delete the proof
		// that the gate is *not* read here, which is the more valuable of the two facts.
		// eslint-disable-next-line no-restricted-syntax
		const { _id } = await seedShopOwner({}, { waitApprov: true })
		const refresh = await seedSession(_id)

		const { status, json } = await gql('{ helloRefresh { txt } }', { cookie: signedCookie(refresh) })

		expect(status).toBe(200)
		expect(json.errors).toBeUndefined()
		expect(json.data).toEqual({ helloRefresh: { txt: 'Hello from helloRefresh' } })
	})
})

// The whole point of this service. Every earlier case stops at the gate; these two drive the
// resolver itself, which is the only code on this tier that writes to Redis. Mocked unit tests
// can show hSet was called — only the live cluster shows the rotated session another service
// will read, and that the token just spent is really gone.
describe('refresh rotates the session on the cluster', () => {
	const mutation = 'mutation { refresh { status accessToken } }'

	it('writes the new pair, arms both TTLs, and deletes the refresh token it consumed', async () => {
		const { _id, email } = await seedShopOwner()
		const lineage = sessionLineage()
		const oldRefresh = randomUUID()
		const oldRefreshKey = track(sessionKey(`refresh:${oldRefresh}`))
		// A rotation writes two keys of its own beyond the new pair — the lineage's family set and the
		// consumed token's tombstone, both with the refresh token's own 90-day TTL — so both are
		// registered for the drain here, before the call that creates them, rather than after it.
		const keyFamily = track(familyKey(lineage.familyId))
		const keyTombstone = track(tombstoneKey(`refresh:${oldRefresh}`))
		await redisClient.hSet(oldRefreshKey, { _id: _id.toHexString(), tier: TIER.shopOwner, ...lineage })

		const { status, json, setCookie } = await gql(mutation, { cookie: signedCookie(oldRefresh) })

		expect(status).toBe(200)
		expect(json.errors).toBeUndefined()

		// A 200 means the rotation already wrote both keys on the cluster, so they are registered
		// here rather than after the assertions below — a failing expect would otherwise strand the
		// new refresh hash for its whole 90-day TTL.
		const refreshed = json.data?.refresh as { status: boolean; accessToken: string }
		const accessKey = track(sessionKey(`access:${refreshed.accessToken}`))
		const newRefreshKey = track(sessionKey(`refresh:${refreshTokenFrom(setCookie)}`))

		expect(refreshed.status).toBe(true)
		expect(refreshed.accessToken).not.toBe('')
		expect(newRefreshKey).not.toBe(oldRefreshKey)

		// The handler rebuilt ctx.state.user out of Redis + MongoDB and the resolver strips
		// refreshToken back off it, so the new access hash is exactly what the resource tier reads.
		expect(await redisClient.hGetAll(accessKey)).toEqual({ _id: _id.toHexString(), email, tier: TIER.shopOwner })
		// The lineage rides through the rotation unchanged — a family or a login date minted afresh here
		// would hand the session an unlimited life one refresh at a time.
		expect(await redisClient.hGetAll(newRefreshKey)).toEqual({ _id: _id.toHexString(), tier: TIER.shopOwner, ...lineage })

		// Both expire() calls really ran, and ran *after* the hSet. A key whose TTL was armed
		// before its fields would read -1 here.
		const accessTtl = await redisClient.ttl(accessKey)
		expect(accessTtl).toBeGreaterThanOrEqual(ACCESS_TTL_MIN - 5)
		expect(accessTtl).toBeLessThanOrEqual(ACCESS_TTL_MAX)
		expect(await redisClient.ttl(newRefreshKey)).toBeGreaterThan(REFRESH_TOKEN_EXPIRY - 60)

		// One refresh token, one use.
		expect(await redisClient.hGetAll(oldRefreshKey)).toEqual({})

		// ⚠️ And the use left a marker (E14-S02). Without it a replay of the token just consumed is
		// indistinguishable from ordinary expiry, which is the whole difference between "your session
		// ended" and "someone else is holding your refresh token".
		const tombstone = await redisClient.hGetAll(keyTombstone)
		expect(tombstone.familyId).toBe(lineage.familyId)
		expect(Number(tombstone.consumedAt)).toBeGreaterThan(Date.now() - 60_000)
		expect(await redisClient.ttl(keyTombstone)).toBeGreaterThan(REFRESH_TOKEN_EXPIRY - 60)

		// Both halves of the new pair are filed into the family the old session belonged to, which is
		// what a revocation walks when this token is replayed.
		expect((await redisClient.sMembers(keyFamily)).sort()).toEqual([accessKey, newRefreshKey].sort())
		expect(await redisClient.ttl(keyFamily)).toBeGreaterThan(REFRESH_TOKEN_EXPIRY - 60)
	})

	/*
	 * E14-S06 on the cluster. The access token the call arrives with is retired by the rotation, so it
	 * stops working the moment its successor is minted instead of living out the rest of its 30-to-91
	 * minute window in parallel.
	 *
	 * ⚠️ **Asserted as the absence of the key, not as a 401 from the resource service**, which this
	 * suite cannot boot: the access hash *is* what a resource service reads on every request, so a key
	 * that is gone from the cluster is a token that tier can no longer resolve. The moment the resource
	 * tiers grow an integration suite of their own, the end-to-end half belongs there.
	 */
	it('retires the access token the call was made with', async () => {
		const { _id } = await seedShopOwner()
		const lineage = sessionLineage()
		const oldRefresh = randomUUID()
		const oldRefreshKey = track(sessionKey(`refresh:${oldRefresh}`))
		track(familyKey(lineage.familyId))
		track(tombstoneKey(`refresh:${oldRefresh}`))
		await redisClient.hSet(oldRefreshKey, { _id: _id.toHexString(), tier: TIER.shopOwner, ...lineage })

		// The access half of the same session, written the way a login writes it.
		const oldAccess = randomUUID()
		const oldAccessKey = track(sessionKey(`access:${oldAccess}`))
		await redisClient.hSet(oldAccessKey, { _id: _id.toHexString(), tier: TIER.shopOwner })

		const { status, json, setCookie } = await gql(mutation, {
			cookie: signedCookie(oldRefresh),
			authorization: `Bearer access:${oldAccess}`
		})

		expect(status).toBe(200)
		const refreshed = json.data?.refresh as { accessToken: string }
		track(sessionKey(`access:${refreshed.accessToken}`))
		track(sessionKey(`refresh:${refreshTokenFrom(setCookie)}`))

		expect(await redisClient.hGetAll(oldAccessKey)).toEqual({})
	})

	/*
	 * E14-S07 on the cluster. The cookie is still physically valid — `setLoginCookies` gives it the full
	 * `REFRESH_TOKEN_EXPIRY`, and this story does not touch that — and the session is refused anyway,
	 * because the cap is enforced server-side against `originalLogin`. That is the difference the
	 * "remember me" box has always implied and never had.
	 */
	it('refuses a session past its absolute cap while its cookie is still valid', async () => {
		const { _id } = await seedShopOwner()
		const lineage = sessionLineage({ sessionCapDays: '1', originalLogin: `${Date.now() - 2 * 86_400_000}` })
		const refresh = await seedSession(_id, lineage)
		track(familyKey(lineage.familyId))

		const { status, json } = await gql(mutation, { cookie: signedCookie(refresh) })

		expect(status).toBe(498)
		expect(json.message).toBe('Invalid Token')

		// Refused *and* revoked: the family goes with it, so the access token minted by the last
		// rotation of that session cannot outlive the refusal.
		expect(await redisClient.exists(familyKey(lineage.familyId))).toBe(0)
	})

	it('carries onboardingStep through the rotation once onboarding is done', async () => {
		const { _id, email } = await seedShopOwner({ onboardingDone: true, onboardingStep: 'p3' })
		const lineage = sessionLineage()
		const oldRefresh = randomUUID()
		const oldRefreshKey = track(sessionKey(`refresh:${oldRefresh}`))
		track(familyKey(lineage.familyId))
		track(tombstoneKey(`refresh:${oldRefresh}`))
		await redisClient.hSet(oldRefreshKey, { _id: _id.toHexString(), tier: TIER.shopOwner, ...lineage })

		const { json, setCookie } = await gql(mutation, { cookie: signedCookie(oldRefresh) })
		expect(json.errors).toBeUndefined()

		const refreshed = json.data?.refresh as { status: boolean; accessToken: string }
		const accessKey = track(sessionKey(`access:${refreshed.accessToken}`))
		track(sessionKey(`refresh:${refreshTokenFrom(setCookie)}`))

		// makeOnboardingData only yields a step once onboardingDone is set, and it rides along
		// into the access hash — the shopOwner frontend reads it straight back from there.
		expect(await redisClient.hGetAll(accessKey)).toEqual({
			_id: _id.toHexString(),
			email,
			tier: TIER.shopOwner,
			onboardingStep: 'p3'
		})
	})
})

describe('GraphQL over HTTP', () => {
	it('serves the query once the introspection code rescues the expired session', async () => {
		const { status, json } = await gql('{ helloRefresh { txt } }', bypassHeaders())

		expect(status).toBe(200)
		expect(json.errors).toBeUndefined()
		expect(json.data).toEqual({ helloRefresh: { txt: 'Hello from helloRefresh' } })
	})

	// Introspection stays open outside production (buildValidationRules returns no rules), and the
	// schema it reports is the one really assembled in createServer — not a copy rebuilt by a test.
	it('exposes the assembled schema through introspection', async () => {
		const { json } = await gql('{ __schema { queryType { name } mutationType { name } } }', bypassHeaders())

		expect(json.errors).toBeUndefined()
		expect(json.data).toEqual({ __schema: { queryType: { name: 'QueriesApi' }, mutationType: { name: 'MutationsApi' } } })
	})

	it('rejects a GET on the GraphQL endpoint (csrfPrevention / method not allowed)', async () => {
		const res = await fetch(`${base}${ENDPOINT}?query=%7B__typename%7D`, { headers: bypassHeaders() })

		expect(res.status).toBeGreaterThanOrEqual(400)
	})
})

describe('non-GraphQL routes', () => {
	it('serves /health once the cookie gate is satisfied', async () => {
		const res = await fetch(`${base}/health`, { headers: bypassHeaders() })

		expect(res.status).toBe(200)
		const json = (await res.json()) as { status: string; timestamp: string }
		expect(json.status).toBe('OK')
	})

	it('falls through to 404 for an unknown path', async () => {
		const res = await fetch(`${base}/nope`, { headers: bypassHeaders() })

		expect(res.status).toBe(404)
	})
})
