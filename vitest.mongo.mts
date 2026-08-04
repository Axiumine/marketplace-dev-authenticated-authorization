import * as dotenv from 'dotenv'

// vitest.config.mts and test/integration/globalSetup.mts both need these values before any test
// module is imported, so the .env load happens here rather than being left to the sources.
dotenv.config()

const REQUIRED = [
	'MONGO_TEST_CONN_STRING',
	'MONGO_TEST_AUTH_ADMIN',
	'MONGO_TEST_UDBOWNER',
	'MONGO_TEST_PWDDBOWNER',
	'MONGO_TEST_UDBRW',
	'MONGO_TEST_PWDDBRW',
	'MONGO_TEST_DB'
] as const

/** Which MONGO_TEST_* variables this .env leaves unset. Empty array once fully configured. */
export function missingTestMongoEnv(): string[] {
	return REQUIRED.filter((name) => !process.env[name])
}

/**
 * Fail with the setup instructions when the block is incomplete.
 *
 * Only globalSetup calls this, on purpose: vitest evaluates one config for BOTH projects, so
 * throwing from module scope here would take `yarn test:unit` down with it over variables the unit
 * project never reads. Deferring keeps the failure where it belongs — the integration project.
 */
export function assertTestMongoEnv(): void {
	const missing = missingTestMongoEnv()
	if (missing.length === 0) return

	throw new Error(
		`Missing ${missing.join(', ')}. The integration project needs the MONGO_TEST_* block in .env — ` +
			`copy the users from marketplace-db-setup/.env, then set MONGO_TEST_DB, MONGO_TEST_AUTH_ADMIN and ` +
			`the database path of MONGO_TEST_CONN_STRING to this service's own database name.`
	)
}

/** The throwaway database the integration suite runs against. Dropped and re-migrated on every run. */
export const TEST_DB = process.env.MONGO_TEST_DB ?? ''

/** Database name carried in a mongodb:// URL, or '' when the URL has no path segment. */
export function dbNameFromUri(uri: string): string {
	const afterScheme = uri.slice(uri.indexOf('://') + 3)
	const slash = afterScheme.indexOf('/')
	if (slash === -1) return ''
	return afterScheme.slice(slash + 1).split('?')[0]
}

/**
 * The test database is named in three separate variables and all three have to agree:
 *
 *   MONGO_TEST_CONN_STRING  its path segment — the database every non-mongoose client dials
 *   MONGO_TEST_DB           the database mongoose dials, and the one globalSetup DROPS
 *   MONGO_TEST_AUTH_ADMIN   the authSource, i.e. the database the two test users are defined in
 *
 * Three variables can drift, and the drift is silent: buildTestMongoUrl below rebuilds the URL
 * around MONGO_TEST_DB, so a connection string naming a different database still yields a
 * perfectly working URL — pointed at, and dropping, a database its own connection string never
 * named. Checked rather than papered over.
 *
 * Every repo owns a DISTINCT database (dbMarketplaceTest, dbMarketplaceTestPublicRes, …) so two suites
 * cannot drop each other's data mid-run, which is why the name cannot simply be inherited from
 * marketplace-db-setup along with the credentials. The users are shared and are defined per test
 * database; dropping a database does not delete them, because MongoDB keeps every user document
 * in admin.system.users regardless of its authentication database.
 */
export function assertTestMongoDbNames(): void {
	const connDb = dbNameFromUri(process.env.MONGO_TEST_CONN_STRING ?? '')
	const authDb = process.env.MONGO_TEST_AUTH_ADMIN ?? ''

	if (connDb !== TEST_DB) {
		throw new Error(
			`MONGO_TEST_CONN_STRING names database "${connDb}" but MONGO_TEST_DB is "${TEST_DB}". ` +
				`Both must be this service's own test database — fix .env.`
		)
	}

	if (authDb !== TEST_DB) {
		throw new Error(
			`MONGO_TEST_AUTH_ADMIN is "${authDb}" but MONGO_TEST_DB is "${TEST_DB}". The test users are ` +
				`defined in the test database, so the authSource must be that same name — fix .env.`
		)
	}
}

// Handed to the integration project as MONGODB_URI when the block is incomplete. It never gets
// dialled: globalSetup runs assertTestMongoEnv() first and stops the run with a real message.
const UNCONFIGURED_URL = 'mongodb://mongo-test-env-missing.invalid/unconfigured'

/**
 * Assemble the connection URL for one of the two MONGO_TEST_* users.
 *
 * The split-into-pieces shape is the same one marketplace-db-setup/lib/mongoUrl.js assembles, with two
 * additions: the database name goes into the path (mongoose takes it from there, unlike
 * migrate-mongo which is handed a separate `databaseName`), and the caller picks the role.
 *
 *   owner -> MONGO_TEST_UDBOWNER/PWDDBOWNER, holds dbOwner. Only globalSetup uses it: it drops the
 *            database and replays the migrations, which a read/write user may not do.
 *   rw    -> MONGO_TEST_UDBRW/PWDDBRW, holds readWrite. This is what the service under test
 *            connects with, so the suite runs on the same least-privilege grant production uses —
 *            a resolver that quietly needs DDL fails here instead of in production.
 */
export function buildTestMongoUrl(role: 'owner' | 'rw'): string {
	if (missingTestMongoEnv().length > 0) return UNCONFIGURED_URL

	const conn = process.env.MONGO_TEST_CONN_STRING as string
	const user = encodeURIComponent(process.env[role === 'owner' ? 'MONGO_TEST_UDBOWNER' : 'MONGO_TEST_UDBRW'] as string)
	const password = encodeURIComponent(process.env[role === 'owner' ? 'MONGO_TEST_PWDDBOWNER' : 'MONGO_TEST_PWDDBRW'] as string)
	const authSource = process.env.MONGO_TEST_AUTH_ADMIN as string

	// globalSetup DROPS this database. Refuse outright if it is the one the service uses for real —
	// the two live side by side on the same cluster and only the name tells them apart. This one
	// stays eager: it is a safety check, and a checkout that trips it is misconfigured either way.
	const devDb = dbNameFromUri(process.env.MONGODB_URI ?? '')
	if (devDb && devDb === TEST_DB) {
		throw new Error(`MONGO_TEST_DB (${TEST_DB}) is the database MONGODB_URI points at. Refusing: the suite drops it.`)
	}

	assertTestMongoDbNames()

	const queryAt = conn.indexOf('?')
	const base = queryAt === -1 ? conn : conn.slice(0, queryAt)
	const params = new URLSearchParams(queryAt === -1 ? '' : conn.slice(queryAt + 1))
	params.set('authSource', authSource)

	// MONGO_TEST_CONN_STRING ends in a database path, and mongoose takes the database from there
	// (unlike migrate-mongo, which is handed a separate `databaseName`). The path is rebuilt from
	// MONGO_TEST_DB rather than reused as-is because the URL also has to gain credentials and an
	// authSource, and appending to the existing string would concatenate into the namespace
	// `dbMarketplaceTestPublicRes/dbMarketplaceTestPublicRes`. assertTestMongoDbNames has already proved the
	// two names are equal, so this rebuild only normalises the shape — it cannot retarget the URL.
	const hostsEnd = base.indexOf('/', base.indexOf('://') + 3)
	const hosts = hostsEnd === -1 ? base : base.slice(0, hostsEnd)

	// replace() hits the first '://' only, which is the scheme separator.
	return `${hosts.replace('://', `://${user}:${password}@`)}/${TEST_DB}?${params.toString()}`
}
