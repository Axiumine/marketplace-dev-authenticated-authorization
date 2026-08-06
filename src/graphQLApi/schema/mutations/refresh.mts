import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { setLoginCookies } from '@axiumine/koa-utils/lib/setLoginCookies'
import {
	accessTokenExpiry,
	generateAccessToken,
	generateRefreshToken,
	REFRESH_TOKEN_EXPIRY
} from '@axiumine/koa-utils/lib/tokens'
import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { IContextAuthenticatedAuthorization } from '@lib/auth/IContextAuthenticatedAuthorization.mjs'
import { RefreshType } from '@ptypes/RefreshType.mjs'
import { IRefreshData } from '@thedoctorweb_agency/marketplace-common/others/IRefreshData'
import * as Sentry from '@sentry/node'
import * as dotenv from 'dotenv'
import { GraphQLError, GraphQLNonNull } from 'graphql'

dotenv.config()

export const refresh = {
	description: 'refresh token',
	type: new GraphQLNonNull(RefreshType),
	async resolve(_: unknown, {}, ctx: IContextAuthenticatedAuthorization) {
		// `status` is only ever read once, in the `return` below. The try block's only exit
		// before that return sets it to `true`, and the catch block's last statement,
		// tryCatchRethrow(e), throws unconditionally in every branch (GraphQLError, Mongo
		// error, or anything else) — so a caught error never reaches `return` at all. There is
		// no path on which this declared value is observable: flipping it cannot change any
		// output. Equivalent mutant.
		// Stryker disable next-line BooleanLiteral: initial value is provably unobservable, see comment above
		let status = false // default

		// holds the refresh token; the access token has already expired

		// legge dal db le info da mettere nell'Access Token -
		// not needed for now: only the userId carried by the current refresh token is read

		// genera i 2 nuovi token
		let accessToken = generateAccessToken()
		let refreshToken = generateRefreshToken()
		const keyAccess = `${process.env.REDIS_KEY}access:${accessToken}`
		const keyRefresh = `${process.env.REDIS_KEY}refresh:${refreshToken}`

		let accessTokenData = ctx.state.user
		const oldRefresh = ctx.state.user.refreshToken
		// @ts-expect-error delete refresh
		delete accessTokenData.refreshToken

		//const refreshTokeNData: IRefreshDataWt = { _id: accessTokenData._id, org: accessTokenData.org }
		// The tier is carried into both new hashes. `accessTokenData` is `ctx.state.user`, which the
		// authorization middleware built *after* asserting the tier of the incoming refresh session —
		// so this propagates a value that has already been checked, it does not re-derive one.
		const refreshTokenData: IRefreshData = { _id: accessTokenData._id, tier: accessTokenData.tier }

		try {
			// Store session in Redis
			await Promise.all([
				redisClient.hSet(keyAccess, accessTokenData as unknown as Record<string, string>),
				redisClient.hSet(keyRefresh, refreshTokenData as unknown as Record<string, string>)
			])

			// se expiry
			const accTokenExp = accessTokenExpiry()

			await Promise.all([redisClient.expire(keyAccess, accTokenExp), redisClient.expire(keyRefresh, REFRESH_TOKEN_EXPIRY)])

			setLoginCookies(ctx, refreshToken)

			// delete the refresh token this call was made with
			await redisClient.del(`${process.env.REDIS_KEY}${oldRefresh}`)

			status = true
		} catch (e) {
			Sentry.captureException(e)
			// Both assignments below clear the just-generated tokens out of these local
			// variables before tryCatchRethrow(e) throws unconditionally two lines down (see
			// the note on `status` above) and unwinds this stack frame. Nothing reads
			// `refreshToken`/`accessToken` again on this path — not a log, not a caller, not a
			// return — so the string these variables are set to can never be observed by any
			// test. Equivalent mutant.
			// Stryker disable next-line StringLiteral: cleared value is provably unobservable, see comment above
			refreshToken = accessToken = ''
			// delete keys
			await Promise.all([redisClient.del(keyAccess), redisClient.del(keyRefresh)])
			// Stryker disable next-line StringLiteral: cleared value is provably unobservable, see comment above
			accessToken = ''
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return {
			status,
			accessToken
		}
	}
}
