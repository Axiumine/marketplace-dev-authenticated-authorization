import { throwUnauthorizedError } from '@axiumine/koa-utils/graphQL/throw/throwUnauthorizedError'
import { ShopOwner } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/ShopOwner'
import { IShopOwnerModel } from '@thedoctorweb_agency/marketplace-common/models/MongoDBInterfaces/IShopOwnerModel'
import { checkUserAuthorizationDisDel } from '@thedoctorweb_agency/marketplace-common/others/checkUserAuthorizationDisDel'
import { Types } from 'mongoose'

/**
 * Try to login ShopOwner user
 * @param _id
 */
export async function tokenInfoShopOwner(_id: Types.ObjectId): Promise<IShopOwnerModel> {
	const user: IShopOwnerModel | null = await ShopOwner.findById(
		{ _id: _id },
		'_id login.email login.firstLogin login.onboardingStep login.onboardingDone deleted disabled'
	).lean()

	if (user === null) {
		throw throwUnauthorizedError()
	}
	checkUserAuthorizationDisDel(user)
	return user
}
