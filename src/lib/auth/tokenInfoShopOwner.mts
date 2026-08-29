import { ShopOwner } from '@axiumine/marketplace-common/models/MongoDB/ShopOwner'
import { IShopOwnerModel } from '@axiumine/marketplace-common/models/MongoDBInterfaces/IShopOwnerModel'
import { checkShopOwnerApproval } from '@axiumine/marketplace-common/others/checkShopOwnerApproval'
import { findAccountForSession } from '@axiumine/marketplace-common/others/findAccountForSession'
import { Types } from 'mongoose'

/**
 * Re-reads the shop owner behind a refresh session. The two guards — no document, then
 * disabled/deleted — are shared with the other two tiers and live in `findAccountForSession`; the
 * model, the projection and the third guard are what this tier contributes.
 *
 * ⚠️ **The approval gate runs on every refresh, not at login only.** `findAccountForSession` gives
 * the reasoning for `disabled`/`deleted` and it holds identically here: an admin who parks a shop
 * owner mid-session should stop them within one access-token lifetime, not one refresh-token
 * lifetime. Until E01-S10 nothing read `waitApprov` at all, so parking an account did nothing to the
 * session it already held — and nothing to the next login either.
 *
 * `waitApprov` is read here and never written: BC-03 owns the write, and a ShopOwner-tier service
 * able to raise or clear it could approve its own account. The eslint block in this repo bans it in
 * a write position for exactly that reason.
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
	const shopOwner = await findAccountForSession<IShopOwnerModel>(
		ShopOwner,
		_id,
		'_id login.email login.firstLogin login.onboardingStep login.onboardingDone deleted disabled waitApprov'
	)

	checkShopOwnerApproval(shopOwner)

	return shopOwner
}
