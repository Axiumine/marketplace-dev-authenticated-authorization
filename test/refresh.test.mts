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
const keyAccess = `test:access:${ACCESS}`
const keyRefresh = `test:refresh:${REFRESH}`

function makeCtx() {
	return {
		state: { user: { _id: OID, email: 'owner@marketplace.test', refreshToken: OLD_REFRESH } },
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
		expect(hSet).toHaveBeenCalledWith(keyAccess, { _id: OID, email: 'owner@marketplace.test' })
		expect(hSet).toHaveBeenCalledWith(keyRefresh, { _id: OID })
		expect(hSet).toHaveBeenCalledTimes(2)

		expect(expire).toHaveBeenCalledWith(keyAccess, ACCESS_EXPIRY)
		expect(expire).toHaveBeenCalledWith(keyRefresh, REFRESH_EXPIRY)

		expect(setLoginCookies).toHaveBeenCalledExactlyOnceWith(ctx, REFRESH)
		// The old refresh key is prefixed here because state.user.refreshToken holds it unprefixed.
		expect(del).toHaveBeenCalledExactlyOnceWith(`test:${OLD_REFRESH}`)
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
