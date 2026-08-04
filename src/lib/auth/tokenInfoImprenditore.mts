import { throwUnauthorizedError } from '@axiumine/koa-utils/graphQL/throw/throwUnauthorizedError'
import { Imprenditore } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Imprenditore'
import { IImprenditoreModel } from '@thedoctorweb_agency/marketplace-common/models/MongoDBInterfaces/IImprenditoreModel'
import { checkUserAuthorizationDisDel } from '@thedoctorweb_agency/marketplace-common/others/checkUserAuthorizationDisDel'
import { Types } from 'mongoose'

/**
 * Try to login Imprenditore user
 * @param _id
 */
export async function tokenInfoImprenditore(_id: Types.ObjectId): Promise<IImprenditoreModel> {
	const utente: IImprenditoreModel | null = await Imprenditore.findById(
		{ _id: _id },
		'_id login.email login.firstLogin login.onboardingStep login.onboardingDone deleted disabled'
	).lean()

	if (utente === null) {
		throw throwUnauthorizedError()
	}
	checkUserAuthorizationDisDel(utente)
	return utente
}
