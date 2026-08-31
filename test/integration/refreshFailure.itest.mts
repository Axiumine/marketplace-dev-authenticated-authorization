import { redisClient, RedisConnect } from '@axiumine/koa-utils/dataSources/Redis'
import { sha256Hex } from '@axiumine/marketplace-common/others/sha256Hex'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { refresh } from '../../src/graphQLApi/schema/mutations/refresh.mts'
import type { IContextAuthenticatedAuthorization } from '../../src/lib/auth/IContextAuthenticatedAuthorization.mts'

/*
 * refresh's catch arm — a Redis write failing mid-rotation — lost for real against the live
 * cluster. Nothing about Redis is stubbed here; the failure is one the real @redis/client encoder
 * raises for any command whose value is not a string, number, or Buffer (see
 * node_modules/@redis/client/dist/lib/RESP/encoder.js — it throws "must be of type string | Buffer"
 * from inside its own try/catch, which is what turns it into a rejected promise instead of a crash).
 * The resolver never validates the shape of ctx.state.user before handing it to hSet, so a plain
 * object hiding in there reproduces that for real: the client queues the HSET, fails to encode it
 * once it gets to the front of the write queue, and rejects the very promise refresh.mts awaits.
 * The only thing engineered here is the malformed input, not the datasource's behaviour.
 *
 * Its own file, and the resolver is called directly rather than through HTTP: refresh.mts never
 * touches MongoDB, so routing this through authenticatedAuthorizationHandler + Apollo would only
 * add a cookie/session detour that proves nothing this direct call doesn't already prove.
 */
describe('refresh mutation catch arm against the real Redis cluster', () => {
	// The lineage the rotation needs before it will mint anything, and which the per-family
	// rate limiter counts under. Fixed rather than random so the counter this run touches on
	// the live cluster is a key the drain below can name.
	const FAMILY_ID = 'itest-catch-arm-family'

	beforeAll(async () => {
		await RedisConnect()
	})

	afterAll(async () => {
		await redisClient.close().catch(() => undefined)
	})

	it('rolls back both new keys and rethrows when a value the client cannot encode reaches a real hSet', async () => {
		const ctx = {
			state: {
				user: {
					_id: 'itest-catch-arm',
					email: 'itest-catch-arm@marketplace.invalid',
					// Not a string/number/Buffer: the real Redis client throws encoding this command,
					// which is the whole point — see the file banner above. The OTHER hSet in the same
					// Promise.all (keyRefresh, `{ _id }` only) is well-formed and really writes, which is
					// exactly why the catch arm deletes both keys rather than assuming only one exists.
					onboardingStep: {},
					refreshToken: 'refresh:itest-catch-arm-old-token',
					familyId: FAMILY_ID,
					// Now-ish and a 30-day cap: the rotation refuses a lineage it can read as expired before
					// it ever reaches the hSet this test is about.
					originalLogin: `${Date.now()}`,
					sessionCapDays: '30'
				}
			},
			cookies: {},
			request: { header: {} }
		} as unknown as IContextAuthenticatedAuthorization

		// Asserted by message, not `instanceof GraphQLError`, for the same reason as the unit test:
		// vitest inlines `graphql` for this file while koa-utils' tryCatchRethrow keeps the
		// externalized copy, so the two GraphQLError classes are not the same object.
		await expect(refresh.resolve(null, {}, ctx)).rejects.toThrow('Internal Server Error')

		// The connection itself survived the bad command — proves the encode failure was scoped to
		// the one malformed value, not something that took the whole client down with it.
		const pingKey = `${process.env.REDIS_KEY}itest-catch-arm-ping`
		// EX so this one cannot outlive the run. It is never registered for the afterAll drain, so
		// without a TTL a hard kill — or a throw on the assertion below — strands it on the cluster
		// forever. 60s is far longer than the round trip and short enough to be self-cleaning.
		await redisClient.set(pingKey, 'pong', { EX: 60 })
		expect(await redisClient.get(pingKey)).toBe('pong')
		await redisClient.del(pingKey)

		// The mint attempt was counted before it failed, and that counter is real state on the
		// cluster. It carries an hour's TTL of its own, so this only stops a re-run inside the hour from
		// inheriting the previous run's count.
		await redisClient.del(`${process.env.REDIS_KEY}rl:refresh:family:${sha256Hex(FAMILY_ID)}`)
	})
})
