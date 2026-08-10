import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { IContextAuthenticatedAuthorization } from '../src/lib/auth/IContextAuthenticatedAuthorization.mts'

const hSet = vi.fn()
const expire = vi.fn()
const del = vi.fn()
const setLoginCookies = vi.fn()
const captureException = vi.fn()

const ACCESS = 'new-access-token'
const REFRESH = 'new-refresh-token'
const ACCESS_EXPIRY = 900
const REFRESH_EXPIRY = 2592000

vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient: { hSet, expire, del } }))
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

function makeCtx() {
	return {
		state: { user: { _id: OID, email: 'owner@marketplace.test', tier: 'shopOwner', refreshToken: OLD_REFRESH } },
		cookies: {},
		request: { header: {} }
	} as unknown as IContextAuthenticatedAuthorization
}

describe('refresh mutation', () => {
	beforeEach(() => {
		hSet.mockReset().mockResolvedValue(1)
		expire.mockReset().mockResolvedValue(true)
		del.mockReset().mockResolvedValue(1)
		setLoginCookies.mockReset()
		captureException.mockReset()
	})

	it('rotates both tokens, re-seeds Redis, sets the cookie and drops the used refresh', async () => {
		const ctx = makeCtx()

		await expect(refresh.resolve(null, {}, ctx)).resolves.toEqual({ status: true, accessToken: ACCESS })

		// The access session carries the user payload minus refreshToken — the resolver strips it so
		// the refresh token is never readable from an access-token lookup.
		expect(hSet).toHaveBeenCalledWith(keyAccess, { _id: OID, email: 'owner@marketplace.test', tier: 'shopOwner' })
		// The refresh hash keeps the tier alongside the _id — see setRedisLoginSessionShopOwner in
		// marketplace-dev-public-authorization for why it is the one field that survives a refresh.
		expect(hSet).toHaveBeenCalledWith(keyRefresh, { _id: OID, tier: 'shopOwner' })
		expect(hSet).toHaveBeenCalledTimes(2)

		expect(expire).toHaveBeenCalledWith(keyAccess, ACCESS_EXPIRY)
		expect(expire).toHaveBeenCalledWith(keyRefresh, REFRESH_EXPIRY)

		expect(setLoginCookies).toHaveBeenCalledExactlyOnceWith(ctx, REFRESH)
		// Both shapes, in that order, and each with its own single-key del (BCON-08): the digest and the
		// raw token hash to different slots, so one multi-key del would not survive a cluster.
		expect(del.mock.calls).toEqual([[oldKey], [oldRawKey]])
		expect(oldKey).not.toContain(OLD_REFRESH)
		expect(captureException).not.toHaveBeenCalled()
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
		expect(setLoginCookies).not.toHaveBeenCalled()
	})

	it('rolls back and rethrows when the expiry write fails, after the sessions were stored', async () => {
		expire.mockRejectedValueOnce(new Error('expire failed'))

		await expect(refresh.resolve(null, {}, makeCtx())).rejects.toThrow('Internal Server Error')

		// A session without a TTL would never expire, so both keys must go.
		expect(del).toHaveBeenCalledWith(keyAccess)
		expect(del).toHaveBeenCalledWith(keyRefresh)
		expect(setLoginCookies).not.toHaveBeenCalled()
	})
})
