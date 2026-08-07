import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { IContextAuthenticatedAuthorization } from '@lib/auth/IContextAuthenticatedAuthorization.mjs'
import { RefreshType } from '@ptypes/RefreshType.mjs'
import * as Sentry from '@sentry/node'
import { refreshSessionTokens } from '@thedoctorweb_agency/marketplace-common/others/refreshSessionTokens'
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
		return refreshSessionTokens({
			store: redisClient,
			ctx,
			session: ctx.state.user,
			captureException: Sentry.captureException
		})
	}
}
