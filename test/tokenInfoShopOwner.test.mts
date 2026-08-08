import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const lean = vi.fn()
const findById = vi.fn(() => ({ lean }))
const checkUserAuthorizationDisDel = vi.fn()

vi.mock('@axiumine/marketplace-common/models/MongoDB/ShopOwner', () => ({ ShopOwner: { findById } }))
vi.mock('@axiumine/marketplace-common/others/checkUserAuthorizationDisDel', () => ({ checkUserAuthorizationDisDel }))

const { tokenInfoShopOwner } = await import('../src/lib/auth/tokenInfoShopOwner.mts')

const _id = new Types.ObjectId('507f1f77bcf86cd799439011')

describe('tokenInfoShopOwner', () => {
	beforeEach(() => {
		lean.mockReset()
		findById.mockClear()
		checkUserAuthorizationDisDel.mockReset()
	})

	it('returns the lean record and runs the disabled/deleted gate on it', async () => {
		const user = { _id, login: { email: 'owner@marketplace.test' }, deleted: false, disabled: false }
		lean.mockResolvedValueOnce(user)

		await expect(tokenInfoShopOwner(_id)).resolves.toBe(user)

		// The projection is part of the contract: the handler reads login.email and the onboarding
		// fields off the result, and the gate reads deleted/disabled.
		expect(findById).toHaveBeenCalledExactlyOnceWith(
			{ _id },
			'_id login.email login.firstLogin login.onboardingStep login.onboardingDone deleted disabled'
		)
		expect(checkUserAuthorizationDisDel).toHaveBeenCalledExactlyOnceWith(user)
	})

	it('throws unauthorized when no shopOwner matches the id', async () => {
		lean.mockResolvedValueOnce(null)

		await expect(tokenInfoShopOwner(_id)).rejects.toThrow()
		expect(checkUserAuthorizationDisDel).not.toHaveBeenCalled()
	})

	it('propagates the gate rejection for a disabled or deleted shopOwner', async () => {
		lean.mockResolvedValueOnce({ _id, login: { email: 'owner@marketplace.test' }, disabled: true })
		checkUserAuthorizationDisDel.mockImplementationOnce(() => {
			throw new Error('disabled')
		})

		await expect(tokenInfoShopOwner(_id)).rejects.toThrow('disabled')
	})
})
