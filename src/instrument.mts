import 'dotenv/config'

import * as Sentry from '@sentry/node'
import type * as http from 'http'
import * as https from 'https'

// Exported so the test can assert it is the object actually handed to Sentry.init,
// and drive request() directly instead of reaching into the module's closure.
export const insecureHttpsModule = {
	...https,
	request: (options: https.RequestOptions, callback?: (res: http.IncomingMessage) => void) => {
		options.rejectUnauthorized = false
		return https.request(options, callback)
	}
}

Sentry.init({
	dsn: process.env.DSN,
	transportOptions: {
		httpModule: insecureHttpsModule
	}
})
