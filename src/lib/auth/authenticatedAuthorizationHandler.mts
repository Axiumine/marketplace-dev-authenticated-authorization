import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { IContextRefresh } from '@axiumine/koa-utils/graphQL/schema/context/IContextRefresh'
import { verifySignedRefreshToken } from '@axiumine/koa-utils/koa/middleware/authenticatedAuthorizationHandler/verifySignedRefreshToken'
import { makeOnboardingData } from '@axiumine/koa-utils/lib/makeOnboardingData'
import { IRedisDataShopOwnerCommon } from '@axiumine/marketplace-common/others/Redis/IRedisDataShopOwnerCommon'
import { guardRefreshAttempt } from '@axiumine/marketplace-common/others/refreshRateLimit'
import { resolveAuthorizationSession } from '@axiumine/marketplace-common/others/resolveAuthorizationSession'
import { TIER } from '@axiumine/marketplace-common/others/Tier'
import { IContextAuthenticatedAuthorization } from '@lib/auth/IContextAuthenticatedAuthorization.mjs'
import { tokenInfoShopOwner } from '@lib/auth/tokenInfoShopOwner.mjs'
import * as dotenv from 'dotenv'
import Keygrip from 'keygrip'
import { Next } from 'koa'

dotenv.config()

/******************
 * receives the refresh token, which carries only the user's _id — not everything the access token holds!
 *
 * The lookup, the tier assertion and the shape of the session are shared with the admin and customer
 * authorization services and live in `resolveAuthorizationSession`. What stays here is the only part that
 * is genuinely this tier's: which collection the `_id` is read from, and the onboarding step a shop
 * owner's session carries and the other two tiers have no equivalent of.
 */

export const authenticatedAuthorizationHandler =
	(keys: Keygrip) => async (ctx: IContextAuthenticatedAuthorization, next: Next) => {
		const refreshToken = verifySignedRefreshToken(ctx as unknown as IContextRefresh, keys)

		// ⚠️ **Before the session read, and that is the whole point**. This is the only limiter that
		// ever meters a token resolving to nothing — garbage, expired, tombstoned — because the per-family one
		// is never reached by a token that names no family. Twenty attempts a minute per token; the signature
		// has already been checked above, so a caller with no valid cookie never gets this far either.
		await guardRefreshAttempt(redisClient, refreshToken)

		ctx.state.user = await resolveAuthorizationSession<IRedisDataShopOwnerCommon>({
			store: redisClient,
			refreshToken,
			tier: TIER.shopOwner,
			readSessionData: async (_id) => {
				const shopOwner = await tokenInfoShopOwner(_id)
				const onboardingStep = makeOnboardingData(shopOwner.login)

				const sessionData: IRedisDataShopOwnerCommon = { email: shopOwner.login.email }
				// Absent rather than `undefined`: the session is written to a Redis hash, and hSet
				// rejects an undefined value instead of skipping the field.
				if (onboardingStep !== null) sessionData.onboardingStep = onboardingStep

				return sessionData
			}
		})

		return next()
	}
