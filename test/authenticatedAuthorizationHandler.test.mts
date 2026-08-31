import Keygrip from 'keygrip'
import type { Next } from 'koa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { IContextAuthenticatedAuthorization } from '../src/lib/auth/IContextAuthenticatedAuthorization.mts'

const hGetAll = vi.fn()
/*
 * `incr` counts two different things, and which one it counted is the assertion. It is the per-token
 * attempt limiter, which runs on every call, and it is the grace counter, which runs
 * only on a replay inside the window. So the steady-state tests pin the key it was called with rather
 * than that it was never called: the limiter must have counted once, and nothing else may have.
 *
 * It counted a third thing once — `dual-read-hits`, the fallback that let a pre-cutover session
 * resolve. The assertions below are unchanged by its removal, which is the point of having written them
 * as an exact call list rather than as a count.
 */
const incr = vi.fn()
// The limiter's other two commands: it arms the window on the first attempt, and reads the TTL back
// only when it finds a counter that has somehow lost one.
const expire = vi.fn()
const ttl = vi.fn()
const tokenInfoShopOwner = vi.fn()
const makeOnboardingData = vi.fn()

// The two commands a family revocation needs: every session filed under the lineage is read
// back, then deleted one key at a time. Only the replay test reaches them; a mock without them fails that
// test with `store.sMembers is not a function` rather than with the refusal it is asserting.
const sMembers = vi.fn()
const del = vi.fn()

// The two the reuse trail adds on top of them — `expire` is the third and the limiter already
// needs it. Only a revocation the tombstone could attribute to an account reaches these.
const lPush = vi.fn()
const lTrim = vi.fn()

vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({
	redisClient: { hGetAll, incr, expire, ttl, sMembers, del, lPush, lTrim }
}))
vi.mock('@axiumine/koa-utils/lib/makeOnboardingData', () => ({ makeOnboardingData }))
vi.mock('@lib/auth/tokenInfoShopOwner.mjs', () => ({ tokenInfoShopOwner }))

const { authenticatedAuthorizationHandler } = await import('../src/lib/auth/authenticatedAuthorizationHandler.mts')

const keys = new Keygrip(['test-key-1', 'test-key-2'], 'sha512', 'base64')
const REFRESH = '27119032-9043-4a9f-bd4c-9d06fd576290'
// The key that session is written under: the prefix plus the SHA-256 of `refresh:` + it.
const HASHED_KEY = 'test:fd62e117b7af852f29f12e502a239d1b8f31afa959d463de0368d684452cefa5'
// A real 24-hex ObjectId: the handler feeds redData._id straight into new Types.ObjectId().
const OID = '507f1f77bcf86cd799439011'
/*
 * The key the pre-lookup attempt limiter counts under: the prefix, `rl:`, the bucket name, and
 * the SHA-256 of the session digest above — the token hashed a second time. Neither the token nor the key
 * its session lives under is recoverable from it, which is the reason for the second hash. Computed
 * outside this file like every other digest here, so a mutated algorithm cannot agree with itself.
 */
const RATE_LIMIT_KEY = 'test:rl:refresh:token:0b45c6eb3aa4d66a24e7557de17465a30810fc8ec9a90337d016db0e67d2e3c5'
/*
 * The lineage every refresh hash carries, and which `assertRefreshLineage` refuses a
 * session without: a family the rotations of one login share, the instant that login happened, and the
 * number of days it may go on rotating for. The clock is frozen so `originalLogin` can be a literal —
 * a session stamped `Date.now()` at fixture-build time would age between the fixture and the assertion.
 */
const NOW = 1_754_784_000_000
const LINEAGE = { familyId: '4b1a4a5e-0d3a-4a2f-9a5a-2f0f6a1b8c3d', originalLogin: `${NOW - 1000}`, sessionCapDays: '30' }

/*
 * The reuse tombstone the rotation leaves behind for the token it consumed, and the family set it
 * names. The tombstone is the session digest again, under the `used:` namespace — same digest as
 * `HASHED_KEY`, so a replay finds the marker in the slot the session vacated.
 */
const TOMBSTONE_KEY = 'test:used:fd62e117b7af852f29f12e502a239d1b8f31afa959d463de0368d684452cefa5'
const FAMILY_KEY = `test:family:${LINEAGE.familyId}`

// Cookie signed the way Koa emits it: value + `.sig` cookie holding the Keygrip signature.
function signedCookie(token = REFRESH) {
	return `refresh_token=${token}; refresh_token.sig=${keys.sign(`refresh_token=${token}`)}`
}

function makeCtx(header: Record<string, string>) {
	return { request: { header }, state: {} } as unknown as IContextAuthenticatedAuthorization
}

/**
 * Redis returns a prototype-less object; the handler spreads it, so mimic that shape.
 *
 * `tier` has to be here: the handler asserts it before the shopOwner lookup, so a session without
 * one is refused outright — which is the point of the discriminator, and why every fixture that
 * expects to get past the guard has to carry the tier this service accepts.
 *
 * ⚠️ `null` means "omit the field", not "set it to undefined" — a default parameter is skipped only
 * for `undefined`, so `redisSession(OID, undefined)` would hand back a shopOwner session instead of
 * the tier-less one the fail-closed case needs.
 */
function redisSession(_id = OID, tier: string | null = 'shopOwner') {
	const session: Record<string, string> = { _id, ...LINEAGE }
	if (tier !== null) session.tier = tier

	return Object.assign(Object.create(null), session)
}

describe('authenticatedAuthorizationHandler', () => {
	let next: Next

	beforeEach(() => {
		hGetAll.mockReset()
		incr.mockReset().mockResolvedValue(1)
		expire.mockReset().mockResolvedValue(1)
		// -1 is "key exists, no TTL". The limiter only reads this when repairing a window it lost.
		ttl.mockReset().mockResolvedValue(-1)
		sMembers.mockReset().mockResolvedValue([])
		del.mockReset().mockResolvedValue(1)
		lPush.mockReset().mockResolvedValue(1)
		lTrim.mockReset().mockResolvedValue('OK')
		tokenInfoShopOwner.mockReset()
		makeOnboardingData.mockReset().mockReturnValue(null)
		next = vi.fn().mockResolvedValue('next') as unknown as Next
		// ⚠️ `Date` alone. Faking wholesale replaces the microtask queue the awaited handler runs on.
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(NOW)
	})

	afterEach(() => vi.useRealTimers())

	// AB-04: a request carrying no credential is refused
	it('rejects the request without a cookie', async () => {
		const ctx = makeCtx({})

		await expect(authenticatedAuthorizationHandler(keys)(ctx, next)).rejects.toThrow()
		expect(hGetAll).not.toHaveBeenCalled()
		expect(next).not.toHaveBeenCalled()
	})

	// AB-05: a credential of the wrong shape is refused — a bad scheme, a broken signature
	it('rejects a cookie with an invalid signature', async () => {
		const ctx = makeCtx({ cookie: `refresh_token=${REFRESH}; refresh_token.sig=fake-signature` })

		await expect(authenticatedAuthorizationHandler(keys)(ctx, next)).rejects.toThrow()
		expect(hGetAll).not.toHaveBeenCalled()
	})

	// AB-01: a valid credential is accepted and the session it resolves reaches ctx.state.user
	it('builds state.user from the Redis session and the shopOwner record', async () => {
		hGetAll.mockResolvedValueOnce(redisSession())
		tokenInfoShopOwner.mockResolvedValueOnce({ login: { email: 'owner@marketplace.test' } })

		const ctx = makeCtx({ cookie: signedCookie() })

		await expect(authenticatedAuthorizationHandler(keys)(ctx, next)).resolves.toBe('next')

		// ⚠️ A digest, not the token. The `refresh:` prefix is inside the hashed value, and the
		// literal is computed elsewhere so a mutated algorithm cannot make this test agree with itself.
		expect(hGetAll).toHaveBeenCalledExactlyOnceWith(HASHED_KEY)
		expect(HASHED_KEY).not.toContain(REFRESH)
		// The limiter counted this attempt and nothing else did: one `INCR` in total, under the rate-limit
		// key rather than under any of the counters that hang off a miss.
		expect(incr.mock.calls).toEqual([[RATE_LIMIT_KEY]])
		// The id string is turned into an ObjectId before the lookup.
		expect(String(tokenInfoShopOwner.mock.calls[0][0])).toBe(OID)
		expect(ctx.state.user).toEqual({
			_id: OID,
			email: 'owner@marketplace.test',
			tier: 'shopOwner',
			refreshToken: `refresh:${REFRESH}`,
			...LINEAGE
		})
		expect(next).toHaveBeenCalledTimes(1)
	})

	it('carries onboardingStep when the shopOwner is still onboarding', async () => {
		hGetAll.mockResolvedValueOnce(redisSession())
		tokenInfoShopOwner.mockResolvedValueOnce({ login: { email: 'owner@marketplace.test' } })
		makeOnboardingData.mockReturnValueOnce(2)

		const ctx = makeCtx({ cookie: signedCookie() })

		await expect(authenticatedAuthorizationHandler(keys)(ctx, next)).resolves.toBe('next')
		expect(ctx.state.user).toEqual({
			_id: OID,
			email: 'owner@marketplace.test',
			tier: 'shopOwner',
			onboardingStep: 2,
			refreshToken: `refresh:${REFRESH}`,
			...LINEAGE
		})
	})

	it('propagates the rejection when the shopOwner is disabled, deleted or gone', async () => {
		hGetAll.mockResolvedValueOnce(redisSession())
		tokenInfoShopOwner.mockRejectedValueOnce(new Error('unauthorized'))

		const ctx = makeCtx({ cookie: signedCookie() })

		await expect(authenticatedAuthorizationHandler(keys)(ctx, next)).rejects.toThrow('unauthorized')
		expect(next).not.toHaveBeenCalled()
	})

	// AB-06: a credential whose session is gone from Redis is refused
	it('rejects when the refresh session no longer exists in Redis', async () => {
		hGetAll.mockResolvedValueOnce({})

		const ctx = makeCtx({ cookie: signedCookie() })

		await expect(authenticatedAuthorizationHandler(keys)(ctx, next)).rejects.toThrow()
		expect(tokenInfoShopOwner).not.toHaveBeenCalled()
		expect(next).not.toHaveBeenCalled()
	})

	/*
	 * Token reuse, and the case with the widest blast radius in this file: a refresh token is consumed by the
	 * rotation that accepted it, so a *second* presentation of the same token is either a client that lost
	 * a multi-tab race or a copy somebody else is holding. Past the ten-second grace window it is read as
	 * the second, and the answer is not "this token is refused" — it is the whole lineage revoked, every
	 * session it ever rotated into included, because a token being replayed means the chain leaked.
	 *
	 * ⚠️ The refusal the caller gets is the ordinary 498 an expired session gets, deliberately: a replayer
	 * learns nothing from the response about whether the revocation happened.
	 */
	// AB-07: a refresh token presented a second time is refused, and its family revoked with it
	it('refuses a replayed refresh token and takes its whole lineage down with it', async () => {
		// Hashed key, then the tombstone: two reads, and only the second answers anything.
		hGetAll.mockResolvedValueOnce({}).mockResolvedValueOnce({ familyId: LINEAGE.familyId, consumedAt: `${NOW - 60_000}` })
		sMembers.mockResolvedValueOnce([HASHED_KEY, 'test:some-access-key'])

		const ctx = makeCtx({ cookie: signedCookie() })

		await expect(authenticatedAuthorizationHandler(keys)(ctx, next)).rejects.toThrow()

		expect(hGetAll).toHaveBeenLastCalledWith(TOMBSTONE_KEY)
		expect(sMembers).toHaveBeenCalledExactlyOnceWith(FAMILY_KEY)
		// One key per `del` (BCON-08), members first and the set itself last: dropping the set before its
		// members would leave every session it named live and unreachable.
		expect(del.mock.calls).toEqual([[HASHED_KEY], ['test:some-access-key'], [FAMILY_KEY]])
		expect(tokenInfoShopOwner).not.toHaveBeenCalled()
		expect(next).not.toHaveBeenCalled()
		// This tombstone predates the reuse trail and names no account, so the mass logout above is revoked and left
		// unexplained. That is the fail-soft direction on purpose: the trail never gates the revocation.
		expect(lPush).not.toHaveBeenCalled()
	})

	/*
	 * The reuse trail through this service's own call site. The revocation above is a mass logout an admin will
	 * eventually have to explain, and the explanation is filed under the account the tombstone names — read
	 * from the marker because by now the session hash the token pointed at is gone.
	 *
	 * ⚠️ **The line holds no token and no digest of one**, asserted here rather than only in the library: the
	 * value written is what an admin's console renders and what a Redis dump would leak.
	 */
	it('files the replay on the account trail, with no token anywhere in the line', async () => {
		hGetAll
			.mockResolvedValueOnce({})
			.mockResolvedValueOnce({ familyId: LINEAGE.familyId, consumedAt: `${NOW - 60_000}`, _id: OID, tier: 'shopOwner' })
		sMembers.mockResolvedValueOnce([HASHED_KEY])

		await expect(authenticatedAuthorizationHandler(keys)(makeCtx({ cookie: signedCookie() }), next)).rejects.toThrow()

		const TRAIL_KEY = `test:reuse:shopOwner:${OID}`

		expect(lPush).toHaveBeenCalledExactlyOnceWith(
			TRAIL_KEY,
			JSON.stringify({
				familyId: LINEAGE.familyId,
				tier: 'shopOwner',
				accountId: OID,
				action: 'refreshTokenReplayed',
				at: `${NOW}`
			})
		)
		// Fifty entries, thirty days: the two bounds the reuse trail states, arriving on the same append.
		expect(lTrim).toHaveBeenCalledExactlyOnceWith(TRAIL_KEY, 0, 49)
		expect(expire).toHaveBeenCalledWith(TRAIL_KEY, 2_592_000)
		expect(lPush.mock.calls[0][1]).not.toContain(REFRESH)
	})

	// The other side of the same read: a token that no live session backs and no tombstone names is
	// ordinary expiry, and revoking a family on it would log a user out for letting a session lapse.
	it('revokes nothing when the missing session left no tombstone behind', async () => {
		hGetAll.mockResolvedValueOnce({})

		await expect(authenticatedAuthorizationHandler(keys)(makeCtx({ cookie: signedCookie() }), next)).rejects.toThrow()

		expect(sMembers).not.toHaveBeenCalled()
		expect(del).not.toHaveBeenCalled()
	})

	// ⚠️ The cross-tier boundary. All nine services read Redis under the same `REDIS_KEY` prefix —
	// deliberately, because the single logout service finds a session by token content alone — so an
	// Admin refresh cookie is *findable* here. `resolveAuthorizationSession` asserts the tier before
	// the `_id` reaches Mongo, which is why every case below also checks that the lookup never ran:
	// refusing after the read would still have leaked whether that id exists in `shopOwner`.
	describe('tier assertion', () => {
		it.each([
			['admin', 'an Admin refresh session'],
			['user', 'a customer refresh session'],
			[null, 'a session minted before the tier field existed']
			// AB-02: a session minted for another tier is refused with 403, not 401
			// AB-03: a session carrying no tier at all is refused — fail closed, never a wildcard
		])('refuses %s (%s)', async (tier) => {
			hGetAll.mockResolvedValueOnce(redisSession(OID, tier))

			const ctx = makeCtx({ cookie: signedCookie() })

			await expect(authenticatedAuthorizationHandler(keys)(ctx, next)).rejects.toThrow()
			expect(tokenInfoShopOwner).not.toHaveBeenCalled()
			expect(next).not.toHaveBeenCalled()
		})

		// 403, not 401 — the caller authenticated, just somewhere else. A 401 tells the client to
		// refresh its way out, which it cannot: the refresh mints another token of the same tier.
		it('refuses with 403, not 401', async () => {
			hGetAll.mockResolvedValueOnce(redisSession(OID, 'admin'))

			await expect(authenticatedAuthorizationHandler(keys)(makeCtx({ cookie: signedCookie() }), next)).rejects.toMatchObject({
				extensions: { http: { status: 403 } }
			})
		})
	})

	/*
	 * Two limiters guard the refresh endpoint and this is the pre-lookup one, the only one that
	 * ever meters a token resolving to nothing: garbage, expired, tombstoned. A token that names no family
	 * never reaches the per-family limiter inside `refreshSessionTokens` at all, so unless the count
	 * happens here, guessing is free.
	 *
	 * Hence the ordering assertion. "Before the session read" is the whole property — a limiter that ran
	 * after `hGetAll` would still let an attacker walk the keyspace one Redis read at a time.
	 */
	it('meters the attempt against the presented token before it reads the session', async () => {
		hGetAll.mockResolvedValueOnce(redisSession())
		tokenInfoShopOwner.mockResolvedValueOnce({ login: { email: 'owner@marketplace.test' } })

		await expect(authenticatedAuthorizationHandler(keys)(makeCtx({ cookie: signedCookie() }), next)).resolves.toBe('next')

		expect(incr).toHaveBeenCalledExactlyOnceWith(RATE_LIMIT_KEY)
		expect(incr.mock.invocationCallOrder[0]).toBeLessThan(hGetAll.mock.invocationCallOrder[0])
		// A minute, and the window is armed on the first attempt of it.
		expect(expire).toHaveBeenCalledExactlyOnceWith(RATE_LIMIT_KEY, 60)
		// Neither the token nor the key its session lives under survives into the counter's name.
		expect(RATE_LIMIT_KEY).not.toContain(REFRESH)
		expect(RATE_LIMIT_KEY).not.toContain(HASHED_KEY.slice('test:'.length))
	})

	/*
	 * The refusal, and what it must cost: one `INCR` and nothing else. No session read, no Mongo lookup,
	 * no `next()` — a refused attempt that still reads Redis and Mongo is a rate limiter that makes the
	 * flood cheaper for the attacker than for the platform.
	 */
	it('refuses the twenty-first attempt of a minute without reading anything', async () => {
		incr.mockResolvedValueOnce(21)

		await expect(authenticatedAuthorizationHandler(keys)(makeCtx({ cookie: signedCookie() }), next)).rejects.toMatchObject({
			extensions: { http: { status: 429 } }
		})

		expect(hGetAll).not.toHaveBeenCalled()
		expect(tokenInfoShopOwner).not.toHaveBeenCalled()
		expect(next).not.toHaveBeenCalled()
	})

	// The twentieth is still served: twenty attempts are allowed, the twenty-first is not, and `>` versus
	// `>=` inside the limiter differs by exactly this call. Mocked at the boundary for that reason.
	it('serves the twentieth attempt of a minute', async () => {
		incr.mockResolvedValueOnce(20)
		hGetAll.mockResolvedValueOnce(redisSession())
		tokenInfoShopOwner.mockResolvedValueOnce({ login: { email: 'owner@marketplace.test' } })

		await expect(authenticatedAuthorizationHandler(keys)(makeCtx({ cookie: signedCookie() }), next)).resolves.toBe('next')
	})
})
