import { ShopOwner } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/ShopOwner'
import { IShopOwnerModel } from '@thedoctorweb_agency/marketplace-common/models/MongoDBInterfaces/IShopOwnerModel'
import { findAccountForSession } from '@thedoctorweb_agency/marketplace-common/others/findAccountForSession'
import { Types } from 'mongoose'

/**
 * Re-reads the shop owner behind a refresh session. The two guards — no document, then
 * disabled/deleted — are shared with the other two tiers and live in `findAccountForSession`; the
 * model and the projection are what this tier contributes.
 *
 * The projection stays here on purpose: it is the one part that genuinely differs per tier, and this
 * is the only one of the three that asks for the onboarding fields, because only a shop owner's
 * session carries a step. Kept inline rather than hoisted to a module constant so it is re-evaluated
 * on every call — a top-level const is evaluated once per process and no test can observe a mutation
 * of it.
 *
 * @param _id
 */
export async function tokenInfoShopOwner(_id: Types.ObjectId): Promise<IShopOwnerModel> {
	return findAccountForSession<IShopOwnerModel>(
		ShopOwner,
		_id,
		'_id login.email login.firstLogin login.onboardingStep login.onboardingDone deleted disabled'
	)
}
