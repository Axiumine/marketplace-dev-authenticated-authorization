import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const lean = vi.fn()
const findById = vi.fn(() => ({ lean }))
const checkUserAuthorizationDisDel = vi.fn()

vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/Imprenditore', () => ({ Imprenditore: { findById } }))
vi.mock('@thedoctorweb_agency/marketplace-common/others/checkUserAuthorizationDisDel', () => ({ checkUserAuthorizationDisDel }))

const { tokenInfoImprenditore } = await import('../src/lib/auth/tokenInfoImprenditore.mts')

const _id = new Types.ObjectId('507f1f77bcf86cd799439011')

describe('tokenInfoImprenditore', () => {
	beforeEach(() => {
		lean.mockReset()
		findById.mockClear()
		checkUserAuthorizationDisDel.mockReset()
	})

	it('returns the lean record and runs the disabled/deleted gate on it', async () => {
		const utente = { _id, login: { email: 'owner@marketplace.test' }, deleted: false, disabled: false }
		lean.mockResolvedValueOnce(utente)

		await expect(tokenInfoImprenditore(_id)).resolves.toBe(utente)

		// The projection is part of the contract: the handler reads login.email and the onboarding
		// fields off the result, and the gate reads deleted/disabled.
		expect(findById).toHaveBeenCalledExactlyOnceWith(
			{ _id },
			'_id login.email login.firstLogin login.onboardingStep login.onboardingDone deleted disabled'
		)
		expect(checkUserAuthorizationDisDel).toHaveBeenCalledExactlyOnceWith(utente)
	})

	it('throws unauthorized when no imprenditore matches the id', async () => {
		lean.mockResolvedValueOnce(null)

		await expect(tokenInfoImprenditore(_id)).rejects.toThrow()
		expect(checkUserAuthorizationDisDel).not.toHaveBeenCalled()
	})

	it('propagates the gate rejection for a disabled or deleted imprenditore', async () => {
		lean.mockResolvedValueOnce({ _id, login: { email: 'owner@marketplace.test' }, disabled: true })
		checkUserAuthorizationDisDel.mockImplementationOnce(() => {
			throw new Error('disabled')
		})

		await expect(tokenInfoImprenditore(_id)).rejects.toThrow('disabled')
	})
})
