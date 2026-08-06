import Keygrip from 'keygrip'
import type { Next } from 'koa'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { IContextAuthenticatedAuthorization } from '../src/lib/auth/IContextAuthenticatedAuthorization.mts'

const hGetAll = vi.fn()
const tokenInfoShopOwner = vi.fn()
const makeOnboardingData = vi.fn()

vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient: { hGetAll } }))
vi.mock('@axiumine/koa-utils/lib/makeOnboardingData', () => ({ makeOnboardingData }))
vi.mock('@lib/auth/tokenInfoShopOwner.mjs', () => ({ tokenInfoShopOwner }))

const { authenticatedAuthorizationHandler } = await import('../src/lib/auth/authenticatedAuthorizationHandler.mts')

const keys = new Keygrip(['test-key-1', 'test-key-2'], 'sha512', 'base64')
const REFRESH = '27119032-9043-4a9f-bd4c-9d06fd576290'
// A real 24-hex ObjectId: the handler feeds redData._id straight into new Types.ObjectId().
const OID = '507f1f77bcf86cd799439011'

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
 */
function redisSession(_id = OID, tier = 'shopOwner') {
	return Object.assign(Object.create(null), { _id, tier })
}

describe('authenticatedAuthorizationHandler', () => {
	let next: Next

	beforeEach(() => {
		hGetAll.mockReset()
		tokenInfoShopOwner.mockReset()
		makeOnboardingData.mockReset().mockReturnValue(null)
		next = vi.fn().mockResolvedValue('next') as unknown as Next
	})

	it('rejects the request without a cookie', async () => {
		const ctx = makeCtx({})

		await expect(authenticatedAuthorizationHandler(keys)(ctx, next)).rejects.toThrow()
		expect(hGetAll).not.toHaveBeenCalled()
		expect(next).not.toHaveBeenCalled()
	})

	it('rejects a cookie with an invalid signature', async () => {
		const ctx = makeCtx({ cookie: `refresh_token=${REFRESH}; refresh_token.sig=fake-signature` })

		await expect(authenticatedAuthorizationHandler(keys)(ctx, next)).rejects.toThrow()
		expect(hGetAll).not.toHaveBeenCalled()
	})

	it('builds state.user from the Redis session and the shopOwner record', async () => {
		hGetAll.mockResolvedValueOnce(redisSession())
		tokenInfoShopOwner.mockResolvedValueOnce({ login: { email: 'owner@marketplace.test' } })

		const ctx = makeCtx({ cookie: signedCookie() })

		await expect(authenticatedAuthorizationHandler(keys)(ctx, next)).resolves.toBe('next')

		expect(hGetAll).toHaveBeenCalledExactlyOnceWith(`test:refresh:${REFRESH}`)
		// The id string is turned into an ObjectId before the lookup.
		expect(String(tokenInfoShopOwner.mock.calls[0][0])).toBe(OID)
		expect(ctx.state.user).toEqual({
			_id: OID,
			email: 'owner@marketplace.test',
			tier: 'shopOwner',
			refreshToken: `refresh:${REFRESH}`
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
			refreshToken: `refresh:${REFRESH}`
		})
	})

	it('propagates the rejection when the shopOwner is disabled, deleted or gone', async () => {
		hGetAll.mockResolvedValueOnce(redisSession())
		tokenInfoShopOwner.mockRejectedValueOnce(new Error('unauthorized'))

		const ctx = makeCtx({ cookie: signedCookie() })

		await expect(authenticatedAuthorizationHandler(keys)(ctx, next)).rejects.toThrow('unauthorized')
		expect(next).not.toHaveBeenCalled()
	})

	it('rejects when the refresh session no longer exists in Redis', async () => {
		hGetAll.mockResolvedValueOnce({})

		const ctx = makeCtx({ cookie: signedCookie() })

		await expect(authenticatedAuthorizationHandler(keys)(ctx, next)).rejects.toThrow()
		expect(tokenInfoShopOwner).not.toHaveBeenCalled()
		expect(next).not.toHaveBeenCalled()
	})

	it('lets a valid x-introspectioncode through an expired session without touching Mongo', async () => {
		hGetAll.mockResolvedValueOnce({})

		const ctx = makeCtx({ cookie: signedCookie(), 'x-introspectioncode': 'test-introspection-code' })

		await expect(authenticatedAuthorizationHandler(keys)(ctx, next)).resolves.toBe('next')
		expect(tokenInfoShopOwner).not.toHaveBeenCalled()
		expect(ctx.state.user).toBeUndefined()
		expect(next).toHaveBeenCalledTimes(1)
	})

	it('ignores a wrong x-introspectioncode', async () => {
		hGetAll.mockResolvedValueOnce({})

		const ctx = makeCtx({ cookie: signedCookie(), 'x-introspectioncode': 'wrong-code' })

		await expect(authenticatedAuthorizationHandler(keys)(ctx, next)).rejects.toThrow()
	})
})
