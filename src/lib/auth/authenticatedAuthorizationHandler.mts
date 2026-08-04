import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { IContextRefresh } from '@axiumine/koa-utils/graphQL/schema/context/IContextRefresh'
import { throwRefreshTokenExpiredOrDeleted } from '@axiumine/koa-utils/graphQL/throw/throwRefreshTokenExpiredOrDeleted'
import { verifySignedRefreshToken } from '@axiumine/koa-utils/koa/middleware/authenticatedAuthorizationHandler/verifySignedRefreshToken'
import { makeOnboardingData } from '@axiumine/koa-utils/lib/makeOnboardingData'
import { IContextAuthenticatedAuthorization } from '@lib/auth/IContextAuthenticatedAuthorization.mjs'
import { tokenInfoShopOwner } from '@lib/auth/tokenInfoShopOwner.mjs'
import { assertTier } from '@thedoctorweb_agency/marketplace-common/others/assertTier'
import { IRedisDataShopOwner } from '@thedoctorweb_agency/marketplace-common/others/Redis/IRedisDataShopOwner'
import { TIER } from '@thedoctorweb_agency/marketplace-common/others/Tier'
import * as dotenv from 'dotenv'
import Keygrip from 'keygrip'
import { Next } from 'koa'
import { Types } from 'mongoose'

dotenv.config()

/******************
 * receives the refresh token, which carries only the user's _id — not everything the access token holds!
 */

export const authenticatedAuthorizationHandler =
	(keys: Keygrip) => async (ctx: IContextAuthenticatedAuthorization, next: Next) => {
		// console.debug('[authorizationHandler] ')

		/***************************
		 * CLIENT: Invia opaque token
		 * - in authorization: ctx.request.header.authorization =  'Bearer TOKEN_HERE
		 * - in cookie: ctx.request.header.cookie = firstName_cookie=TOKEN_HERE
		 */
		/*
    console.debug('[authorizationAuthApiHandlerWt]')
    if (typeof ctx.request.header?.operation !== 'undefined') {
    const operationName = ctx.request.header.operation
    console.debug('[authorizationHandler] operationName: ', operationName)
    }*/

		const refreshTokenRedis = verifySignedRefreshToken(ctx as unknown as IContextRefresh, keys)
		const redSession = await redisClient.hGetAll(`${process.env.REDIS_KEY}${refreshTokenRedis}`)
		if (Object.keys(redSession).length !== 0) {
			const redData = { ...redSession } // For safety, Redis return an object without the default Object.prototype  in its prototype chain.

			// All seven services share one `REDIS_KEY` prefix, so a well-formed refresh session found
			// under this key may have been minted for another tier. Refuse it here, before the _id is
			// looked up in *this* tier's collection — that lookup used to be the only thing standing in
			// the way, and it only ever failed by accident, when the foreign id happened not to exist.
			// A session with no `tier` predates this check and is refused too: fail closed.
			assertTier(redData.tier, TIER.shopOwner)

			/***************************
			 * get info for access_token
			 */
			const uId = redData._id
			const uIdObj = new Types.ObjectId(uId) as Types.ObjectId

			const user = await tokenInfoShopOwner(uIdObj)

			let step
			let email

			step = makeOnboardingData(user.login)
			email = user.login.email

			// this BE only save data to Redis, so we prepare ctx.state.user for Redis
			let tokenData: IRedisDataShopOwner = {
				_id: uId,
				email,
				tier: TIER.shopOwner
			}
			if (step !== null) tokenData.onboardingStep = step

			ctx.state.user = {
				...tokenData,
				refreshToken: refreshTokenRedis
			}
		} else {
			// `ctx.request.header` cannot be nullish here: reaching this branch means
			// verifySignedRefreshToken() (above, inside refreshTokenRedis) already returned
			// without throwing, and it only does that after successfully reading
			// `ctx.request.header?.cookie` as a defined string — which is impossible unless
			// `ctx.request.header` is itself a defined object. The `?.` below can therefore
			// never short-circuit on any reachable input. Equivalent mutant. Pulled into its
			// own statement (rather than inline in the `if` test) so the directive below
			// attaches to this line and not to the enclosing if/else.
			// Stryker disable next-line OptionalChaining: header is provably defined here, see comment above
			const introspectionCode = ctx.request.header?.['x-introspectioncode']
			if (introspectionCode !== `${process.env.INTROSPECTION_CODE}`) {
				throw throwRefreshTokenExpiredOrDeleted()
			} // else return next()
		}

		return next()
	}
