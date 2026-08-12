import {
	APPROVAL_GATE_FIELD_SHOP_OWNER,
	OPERATOR_ONLY_FIELDS_SHOP_OWNER
} from '@axiumine/marketplace-common/others/operatorOnlyFields'
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
		// fields off the result, the shared gate reads deleted/disabled, and the approval gate reads
		// waitApprov.
		expect(findById).toHaveBeenCalledExactlyOnceWith(
			{ _id },
			'_id login.email login.firstLogin login.onboardingStep login.onboardingDone deleted disabled waitApprov'
		)
		expect(checkUserAuthorizationDisDel).toHaveBeenCalledExactlyOnceWith(user)
	})

	// E01-S10. The literal above already fails the moment the projection changes at all, which is the
	// stronger check — but it is also the reason a widening gets waved through: the fix for a failing
	// exact-match assertion is to paste the new string in, and nothing on that line says which fields
	// were never allowed to appear in it. This one says so, and says it in terms of a list owned by the
	// repo that owns the shape, so a third operator-only field landing on `shopOwner` tightens this
	// service with no edit here. `stringContaining`, not a token split: `shopOwnerNotes` would be the
	// same leak under a friendlier name.
	it('projects no field the Admin tier owns', async () => {
		lean.mockResolvedValueOnce({ _id, login: { email: 'owner@marketplace.test' } })

		await tokenInfoShopOwner(_id)

		for (const field of OPERATOR_ONLY_FIELDS_SHOP_OWNER)
			expect(findById).toHaveBeenCalledExactlyOnceWith({ _id }, expect.not.stringContaining(field))
	})

	// The mirror of the test above, and the one that matters most for the approval gate:
	// `checkShopOwnerApproval` cannot refuse a flag it was never handed, so a projection that quietly
	// dropped `waitApprov` would leave the gate in place and unreachable — every parked shop owner
	// refreshing happily, with the call to the gate still sitting there in the source looking correct.
	// Named off the same constant as the negative assertion so a rename of the field fails here too.
	it('projects the approval gate field, or the gate below it can never fire', async () => {
		lean.mockResolvedValueOnce({ _id, login: { email: 'owner@marketplace.test' } })

		await tokenInfoShopOwner(_id)

		expect(findById).toHaveBeenCalledExactlyOnceWith({ _id }, expect.stringContaining(APPROVAL_GATE_FIELD_SHOP_OWNER))
	})

	// BC-03 parks a shop owner pending review by raising this flag, and BC-01 is where that has to
	// bite. Here rather than at login alone for the same reason `findAccountForSession` runs the
	// disabled/deleted gate on every refresh: an operator parking an account mid-session should stop
	// it within one access-token lifetime, not one refresh-token lifetime.
	it('throws unauthorized for a shopOwner awaiting approval', async () => {
		lean.mockResolvedValueOnce({ _id, login: { email: 'owner@marketplace.test' }, waitApprov: true })

		await expect(tokenInfoShopOwner(_id)).rejects.toThrow()
	})

	// `waitApprov` is truthy-or-absent in the collection — `funShopOwnerUpdateStatus` `$unset`s it on
	// approval so the operator queue can stay a `{ $exists: true }` query — but an explicit `false` is
	// a shape a document could carry, and refusing it would lock out every approved shop owner.
	it.each([
		['absent', {}],
		['false', { waitApprov: false }]
	])('lets a shopOwner through when waitApprov is %s', async (_label, approval) => {
		const user = { _id, login: { email: 'owner@marketplace.test' }, ...approval }
		lean.mockResolvedValueOnce(user)

		await expect(tokenInfoShopOwner(_id)).resolves.toBe(user)
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
