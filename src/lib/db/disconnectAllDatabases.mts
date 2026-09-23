import { MongoDBDisconnect } from '@axiumine/koa-utils/dataSources/MongoDB'
import { RedisDisconnect } from '@axiumine/koa-utils/dataSources/Redis'
import * as Sentry from '@sentry/node'

/**
 * Disconnects from all databases and exits the process
 * @param exitCode - The exit code to use when terminating the process
 */
export async function disconnectAllDatabases(exitCode: number = 0): Promise<never> {
	const DISCONNECT_TIMEOUT = 5000 // 5 seconds timeout

	try {
		await Promise.race([
			Promise.all([RedisDisconnect(), MongoDBDisconnect()]),
			new Promise((_, reject) => setTimeout(() => reject(new Error('Database disconnection timeout')), DISCONNECT_TIMEOUT))
		])

		Sentry.captureMessage('All databases disconnected successfully', 'info')
		// This is the last stop before the process dies, for every fatal path that routes through here
		// (start()'s catch included) — flush the SDK's queue or the event above never leaves the process.
		await Sentry.flush(2000)
		process.exit(exitCode)
	} catch (e) {
		Sentry.captureException(e, {
			extra: { detail: 'Error during database disconnection' }
		})
		await Sentry.flush(2000)
		process.exit(1)
	}
}
