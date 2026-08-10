import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { IContextAuthenticatedAuthorization } from '../src/lib/auth/IContextAuthenticatedAuthorization.mts'

const hSet = vi.fn()
const expire = vi.fn()
const del = vi.fn()
const sAdd = vi.fn()
// The per-family mint limiter's two commands (E14-S08). The rotation counts itself before it mints, so
// a mock without these fails the whole suite with `store.incr is not a function`.
const incr = vi.fn()
const ttl = vi.fn()
const setLoginCookies = vi.fn()
const captureException = vi.fn()

const ACCESS = 'new-access-token'
const REFRESH = 'new-refresh-token'
const ACCESS_EXPIRY = 900
const REFRESH_EXPIRY = 2592000

vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient: { hSet, expire, del, sAdd, incr, ttl } }))
vi.mock('@axiumine/koa-utils/lib/setLoginCookies', () => ({ setLoginCookies }))
// Token generation is random by design; pinning it here is what makes the Redis keys assertable.
vi.mock('@axiumine/koa-utils/lib/tokens', () => ({
	generateAccessToken: () => ACCESS,
	generateRefreshToken: () => REFRESH,
	accessTokenExpiry: () => ACCESS_EXPIRY,
	REFRESH_TOKEN_EXPIRY: REFRESH_EXPIRY
}))
vi.mock('@sentry/node', () => ({ captureException }))

const { refresh } = await import('../src/graphQLApi/schema/mutations/refresh.mts')

const OID = '507f1f77bcf86cd799439011'
const OLD_REFRESH = 'refresh:old-refresh-token'
/*
 * Where a rotated session is written since E13-S01: the shared prefix plus the SHA-256 of the
 * **prefixed** token. `access:` and `refresh:` live inside the digest — they are what tells the two
 * hashes apart — and the digests are written out as literals, computed elsewhere: hashing the tokens
 * here with the call the code makes would agree with it about any algorithm, including a mutated one.
 */
const keyAccess = 'test:bacb9a67a033bad50630a548fee3b22ad960f975f52984a3b3be8f76aeab972e'
const keyRefresh = 'test:dae3d6f8bfcf40ccb5fd3f8e02ddc6c84c3ce03c513fdfb241ee09ec53637fc7'
// The two shapes of the *used* refresh token, both deleted on rotation (E13-S02): a session minted
// before the cutover lives under the raw key, and a rotation that dropped only the hashed one would
// leave the token it just retired still usable.
const oldKey = 'test:c934d70b631c47c68f5194a79773e210010efc6874a72193dd1c1e55032ddd6c'
const oldRawKey = `test:${OLD_REFRESH}`
// The marker left behind for the consumed refresh token (E14-S02) — same digest as `oldKey`, under the
// `used:` namespace, so a replay of that token finds the marker after missing the session.
const tombstoneKey = 'test:used:c934d70b631c47c68f5194a79773e210010efc6874a72193dd1c1e55032ddd6c'

/*
 * The access token this call arrives with, `access:` prefix included, and the key it hashes to
 * (E14-S06). The resolver reads it off the `Authorization` header the same way the logout handler
 * does, so the rotation can retire it instead of leaving it live for the rest of its window.
 */
const PRESENTED_ACCESS = 'access:presented-access-token'
const presentedAccessKey = 'test:afe13c669207703740f5fefe1e47e9ca0c5a0b2efb4d5afc2f00750a57f7601e'

// The lineage the session being rotated already carries, and which this rotation must propagate
// unchanged (E14-S01): a family stamped afresh would make the chain unrevocable, an `originalLogin`
// stamped afresh would make the absolute cap unreachable.
const NOW = 1_754_784_000_000
const FAMILY_ID = '4b1a4a5e-0d3a-4a2f-9a5a-2f0f6a1b8c3d'
const LINEAGE = { familyId: FAMILY_ID, originalLogin: `${NOW - 3_600_000}`, sessionCapDays: '30' }
const familyKey = `test:family:${FAMILY_ID}`
/*
 * The lineage's *mint counter* (E14-S08) — a different key from the family set above, and a different
 * digest: `sha256(FAMILY_ID)`, written out as a literal rather than computed here. Twenty pairs an hour,
 * counted before the rotation writes anything.
 */
const rateLimitKey = 'test:rl:refresh:family:eb8e9661945f5feea4260ffdbf474a5125cc7eb0cad7d50dbfda549221efc2f7'

/*
 * ⚠️ `null` means "send no `Authorization` header at all", not "send an undefined one" — a default
 * parameter is skipped only for `undefined`, so `makeCtx(undefined)` would hand back the ordinary
 * header-carrying context and quietly assert nothing about the headerless case.
 */
function makeCtx(authorization: string | null = `Bearer ${PRESENTED_ACCESS}`) {
	return {
		state: {
			user: { _id: OID, email: 'owner@marketplace.test', tier: 'shopOwner', refreshToken: OLD_REFRESH, ...LINEAGE }
		},
		cookies: {},
		request: { header: authorization === null ? {} : { authorization } }
	} as unknown as IContextAuthenticatedAuthorization
}

describe('refresh mutation', () => {
	beforeEach(() => {
		hSet.mockReset().mockResolvedValue(1)
		expire.mockReset().mockResolvedValue(true)
		del.mockReset().mockResolvedValue(1)
		sAdd.mockReset().mockResolvedValue(1)
		// One mint so far this hour, and no window armed yet — an ordinary rotation, well under the limit.
		incr.mockReset().mockResolvedValue(1)
		ttl.mockReset().mockResolvedValue(-1)
		setLoginCookies.mockReset()
		captureException.mockReset()
		// ⚠️ `Date` alone — faking wholesale would replace the microtask queue the awaited rotation runs on.
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(NOW)
	})

	afterEach(() => vi.useRealTimers())

	it('rotates both tokens, re-seeds Redis, sets the cookie and drops the used refresh', async () => {
		const ctx = makeCtx()

		await expect(refresh.resolve(null, {}, ctx)).resolves.toEqual({ status: true, accessToken: ACCESS })

		// The access session carries the user payload minus refreshToken and minus the lineage — the
		// resolver strips the first so the refresh token is never readable from an access-token lookup,
		// and the other three belong to the refresh half alone.
		expect(hSet).toHaveBeenCalledWith(keyAccess, { _id: OID, email: 'owner@marketplace.test', tier: 'shopOwner' })
		// The refresh hash keeps the tier alongside the _id — see setRedisLoginSessionShopOwner in
		// marketplace-dev-public-authorization for why it is the one field that survives a refresh.
		expect(hSet).toHaveBeenCalledWith(keyRefresh, { _id: OID, tier: 'shopOwner', ...LINEAGE })
		expect(hSet).toHaveBeenCalledWith(tombstoneKey, { familyId: FAMILY_ID, consumedAt: `${NOW}` })
		expect(hSet).toHaveBeenCalledTimes(3)

		expect(expire).toHaveBeenCalledWith(keyAccess, ACCESS_EXPIRY)
		expect(expire).toHaveBeenCalledWith(keyRefresh, REFRESH_EXPIRY)
		// Both the family set and the tombstone outlive every member they describe: a set that expired
		// first would leave a live session no revocation could reach, and a tombstone that expired first
		// would turn a replay back into something indistinguishable from ordinary expiry.
		expect(expire).toHaveBeenCalledWith(familyKey, REFRESH_EXPIRY)
		expect(expire).toHaveBeenCalledWith(tombstoneKey, REFRESH_EXPIRY)

		// The pair is filed into the family it inherited, not into a new one.
		expect(sAdd).toHaveBeenCalledExactlyOnceWith(familyKey, [keyAccess, keyRefresh])

		// The rotation metered itself against its own lineage before minting anything, and armed the window
		// it counts in — an hour, the one window long enough to see a rotation loop.
		expect(incr).toHaveBeenCalledExactlyOnceWith(rateLimitKey)
		expect(expire).toHaveBeenCalledWith(rateLimitKey, 3600)

		expect(setLoginCookies).toHaveBeenCalledExactlyOnceWith(ctx, REFRESH)
		// Three single-key deletes (BCON-08): the access token the call was made with, then both shapes
		// of the refresh token it consumed. The digest and the raw token hash to different slots, so one
		// multi-key del would not survive a cluster.
		expect(del.mock.calls).toEqual([[presentedAccessKey], [oldKey], [oldRawKey]])
		expect(oldKey).not.toContain(OLD_REFRESH)
		expect(captureException).not.toHaveBeenCalled()
	})

	/*
	 * E14-S06's tolerant half. A client whose access token expired before it got round to refreshing
	 * sends no `Authorization` header at all — the ordinary case, not an error — and the rotation then
	 * deletes nothing extra rather than computing a key from an empty string and deleting whatever that
	 * happens to hash to.
	 */
	it.each([
		['no Authorization header at all', null],
		['an empty Authorization header', ''],
		['a bare Bearer with no token', 'Bearer ']
	])('rotates without retiring an access token when the call carries %s', async (_label, authorization) => {
		await expect(refresh.resolve(null, {}, makeCtx(authorization))).resolves.toEqual({ status: true, accessToken: ACCESS })

		expect(del.mock.calls).toEqual([[oldKey], [oldRawKey]])
	})

	// Asserted by message, not `instanceof GraphQLError`: vitest inlines and transforms `graphql`
	// for this file while koa-utils keeps the externalized copy, so the two GraphQLError classes
	// are not the same object and an instanceof check would fail on a genuinely correct error.
	it('reports, rolls back both new keys and rethrows when Redis write fails', async () => {
		hSet.mockRejectedValueOnce(new Error('redis down'))

		await expect(refresh.resolve(null, {}, makeCtx())).rejects.toThrow('Internal Server Error')

		expect(captureException).toHaveBeenCalled()
		// Rollback: neither half-written session may survive the failure.
		expect(del).toHaveBeenCalledWith(keyAccess)
		expect(del).toHaveBeenCalledWith(keyRefresh)
		// ⚠️ And nothing else. The rollback undoes what this rotation minted; the session being rotated
		// is still live, so retiring its access token or tombstoning its refresh token here would end a
		// session that a retry could have carried on.
		expect(del.mock.calls.flat()).not.toContain(presentedAccessKey)
		expect(del.mock.calls.flat()).not.toContain(tombstoneKey)
		expect(setLoginCookies).not.toHaveBeenCalled()
	})

	it('rolls back and rethrows when the expiry write fails, after the sessions were stored', async () => {
		// ⚠️ The first `expire` of the call is the rate limiter arming its own window (E14-S08), and it has
		// nothing to do with the session. The TTL write this test is about is the second one.
		expire.mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('expire failed'))

		await expect(refresh.resolve(null, {}, makeCtx())).rejects.toThrow('Internal Server Error')

		// A session without a TTL would never expire, so both keys must go.
		expect(del).toHaveBeenCalledWith(keyAccess)
		expect(del).toHaveBeenCalledWith(keyRefresh)
		expect(setLoginCookies).not.toHaveBeenCalled()
	})
})
