import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { refreshSessionTokens } from '@axiumine/marketplace-common/others/refreshSessionTokens'
import { IContextAuthenticatedAuthorization } from '@lib/auth/IContextAuthenticatedAuthorization.mjs'
import { RefreshType } from '@ptypes/RefreshType.mjs'
import * as Sentry from '@sentry/node'
import * as dotenv from 'dotenv'
import { GraphQLNonNull } from 'graphql'

dotenv.config()

export const refresh = {
	description: 'refresh token',
	type: new GraphQLNonNull(RefreshType),
	async resolve(_: unknown, {}, ctx: IContextAuthenticatedAuthorization) {
		// The rotation itself — mint both tokens, store both hashes, set the cookie, drop the refresh
		// token this call was made with, and roll the two new keys back on any failure — is identical
		// in all three authorization services and lives in `refreshSessionTokens`. Sentry is passed in
		// rather than imported there, so that marketplace-common does not drag it into every consumer.
		// ⚠️ **The access token the call arrived with, `access:` prefix and all**. Read exactly as
		// `authorizationLogoutHandler` reads it — the header, `Bearer ` stripped — so that the rotation can
		// retire it instead of leaving it live for the rest of its 30-to-90-minute window alongside its own
		// successor. A client whose access token has already expired sends none, and that is the ordinary
		// case: `refreshSessionTokens` deletes nothing rather than treating the absence as an error.
		//
		// Two statements rather than one chain, so that only the first `?.` is exempted: `ctx.request.header`
		// cannot be nullish here — this resolver runs behind the authorization middleware, which returns
		// without throwing only after reading `ctx.request.header?.cookie` as a defined string, which is
		// impossible unless the header object is itself defined. The `?.` on `authorization` genuinely can
		// short-circuit, is the ordinary case, and stays mutable so the tests below have to keep killing it.
		// Stryker disable next-line OptionalChaining: header is provably defined here, see comment above
		const authorizationHeader = ctx.request.header?.authorization

		const presentedAccessToken = authorizationHeader?.replace('Bearer ', '')

		return refreshSessionTokens({
			store: redisClient,
			ctx,
			session: ctx.state.user,
			presentedAccessToken,
			captureException: Sentry.captureException
		})
	}
}
