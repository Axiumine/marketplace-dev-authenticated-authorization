import Keygrip from 'keygrip'
import type { Next } from 'koa'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { IContextAuthenticatedAuthorization } from '../src/lib/auth/IContextAuthenticatedAuthorization.mts'

const hGetAll = vi.fn()
// `incr` is the dual-read counter (E13-S02): touched only when a read misses the hashed key and finds
// a raw one, so the steady-state tests assert it was never called.
const incr = vi.fn()
const tokenInfoShopOwner = vi.fn()
const makeOnboardingData = vi.fn()

vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient: { hGetAll, incr } }))
vi.mock('@axiumine/koa-utils/lib/makeOnboardingData', () => ({ makeOnboardingData }))
vi.mock('@lib/auth/tokenInfoShopOwner.mjs', () => ({ tokenInfoShopOwner }))

const { authenticatedAuthorizationHandler } = await import('../src/lib/auth/authenticatedAuthorizationHandler.mts')

const keys = new Keygrip(['test-key-1', 'test-key-2'], 'sha512', 'base64')
const REFRESH = '27119032-9043-4a9f-bd4c-9d06fd576290'
// The key that session is written under since E13-S01: the prefix plus the SHA-256 of `refresh:` + it.
const HASHED_KEY = 'test:fd62e117b7af852f29f12e502a239d1b8f31afa959d463de0368d684452cefa5'
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
 *
 * ⚠️ `null` means "omit the field", not "set it to undefined" — a default parameter is skipped only
 * for `undefined`, so `redisSession(OID, undefined)` would hand back a shopOwner session instead of
 * the tier-less one the fail-closed case needs.
 */
function redisSession(_id = OID, tier: string | null = 'shopOwner') {
	const session: Record<string, string> = { _id }
	if (tier !== null) session.tier = tier

	return Object.assign(Object.create(null), session)
}

describe('authenticatedAuthorizationHandler', () => {
	let next: Next

	beforeEach(() => {
		hGetAll.mockReset()
		incr.mockReset().mockResolvedValue(1)
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

		// ⚠️ A digest, not the token (E13-S01). The `refresh:` prefix is inside the hashed value, and the
		// literal is computed elsewhere so a mutated algorithm cannot make this test agree with itself.
		expect(hGetAll).toHaveBeenCalledExactlyOnceWith(HASHED_KEY)
		expect(HASHED_KEY).not.toContain(REFRESH)
		expect(incr).not.toHaveBeenCalled()
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
})
