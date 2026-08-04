import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { MongoClient } from 'mongodb'

import { assertTestMongoEnv, buildTestMongoUrl, TEST_DB } from '../../vitest.mongo.mts'

/**
 * Provision this service's throwaway database before the integration project runs.
 *
 * Two users, the same split production uses:
 *   - the DB OWNER connects here, drops the database and replays every marketplace-db-setup migration,
 *     so the collections the suite writes to carry the real `$jsonSchema` validators and the real
 *     indexes — a seed that violates one is rejected by the server, not by a hand-written copy;
 *   - the R/W user is the one the service under test connects with (see vitest.config.mts).
 *
 * The migrations are read from the sibling repo rather than duplicated. They are immutable and
 * self-contained by design, so replaying the files directly is equivalent to `migrate:up`; the
 * `changelog` bookkeeping is migrate-mongo's and is not needed for a database that is dropped
 * on every run.
 */

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))

// test/integration -> service root -> dev/ -> BEs/
const MIGRATIONS_DIR = path.resolve(here, '../../../../marketplace-db-setup/migrations')

type Migration = { up: (db: unknown) => Promise<void> }

export async function setup(): Promise<void> {
	// First thing, and only here: vitest.config.mts is evaluated for the unit project too, so the
	// MONGO_TEST_* block is checked at the entry point of the project that actually needs it.
	assertTestMongoEnv()

	let files: string[]
	try {
		files = readdirSync(MIGRATIONS_DIR)
	} catch {
		throw new Error(
			`Cannot read ${MIGRATIONS_DIR}. The integration suite replays the marketplace-db-setup migrations from the sibling checkout — clone it next to this repo (see the workspace CLAUDE.md).`
		)
	}

	// Filename timestamp prefix is the apply order, exactly as migrate-mongo does it.
	const migrations = files.filter((f) => f.endsWith('.js')).sort()
	if (migrations.length === 0) throw new Error(`No migrations found in ${MIGRATIONS_DIR}`)

	// The demo seed is gated on SEED_DEMO and must stay a no-op: the suite seeds its own documents
	// and counts them, which fixed demo rows would silently offset.
	process.env.SEED_DEMO = 'false'

	const client = new MongoClient(buildTestMongoUrl('owner'))
	try {
		await client.connect()
		const db = client.db(TEST_DB)

		await db.dropDatabase()
		for (const file of migrations) {
			const migration = require(path.join(MIGRATIONS_DIR, file)) as Migration
			await migration.up(db)
		}
	} finally {
		await client.close()
	}
}
