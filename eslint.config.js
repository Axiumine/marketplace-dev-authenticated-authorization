import eslintConfig from '@axiumine/eslint-config-be'
import js from '@eslint/js'
import tsParser from '@typescript-eslint/parser'
import simpleImportSort from 'eslint-plugin-simple-import-sort'

// The shared config only covers `src/**`, so the test files and the vitest configs
// (outside src/) would be left without a TS parser. Here we reuse the same rules as the shared
// TypeScript block, but without `project`: tsconfig.json only includes `src/**/*.mts`.
const sharedTsBlock = eslintConfig.find((c) => c.files?.includes('src/**/*.{d.ts,ts,cts,mts}'))

/*
 * BCON-08 and NFR-SC03, and RISK_REGISTER R32.
 *
 * Redis is deployed as a cluster, where `DEL k1 k2` is refused with `CROSSSLOT Keys in request don't hash
 * to the same slot` unless every key lands in the same slot — and nothing here arranges that, because the
 * session and rate-limit keys are digests of tokens. One key per call is therefore not a style
 * preference: the batched form is what every non-cluster Redis codebase writes out of habit,
 * `@redis/client` types it as legal (`del(keys: RedisArgument | Array<RedisArgument>)`), TypeScript is
 * happy, and it fails at runtime on the path that revokes a session. Until this block existed the
 * convention was prose in three documents and machine-checked nowhere.
 *
 * Three selectors, because the batch arrives three ways — `del(a, b)`, `del([a, b])`, `del(...keys)` —
 * and a rule carrying one of them passes the other two. Keyed on the method name alone rather than on
 * `redisClient`, because the client is injected here: the shared session helpers call `store.del(...)`
 * through `ISessionWriteStore`, and a selector naming the client would see none of them. What that width
 * costs is that any `.del()` or `.unlink()` on an unrelated object is held to the same shape — including
 * the callback form of `fs.unlink`, which nothing on this platform uses. A call that genuinely needs two
 * arguments is a decision worth a reviewer, which is what failing here buys.
 *
 * ⚠️ **An identifier holding a pre-built array is invisible to all three.** `const keys = [a, b]` then
 * `store.del(keys)` is a syntax tree this rule cannot distinguish from the single-key call, so the block
 * narrows the ways in rather than closing them — RISK_REGISTER R32 stays open at its measured level for
 * that reason.
 */
const REDIS_DEL_MESSAGE =
	'BCON-08: one Redis key per `del`. Redis is a cluster, so a multi-key `DEL`/`UNLINK` throws CROSSSLOT unless every key hashes to the same slot, which digested session and rate-limit keys never do. Delete one key per call and batch with `Promise.all(keys.map((key) => store.del(key)))` — the shape the session helpers already carry. NFR-SC03, RISK_REGISTER R32.'

const REDIS_ONE_KEY_PER_DEL = [
	{
		selector: 'CallExpression[callee.property.name=/^(del|unlink)$/][arguments.length>1]',
		message: REDIS_DEL_MESSAGE
	},
	{
		selector: 'CallExpression[callee.property.name=/^(del|unlink)$/] > ArrayExpression.arguments',
		message: REDIS_DEL_MESSAGE
	},
	{
		selector: 'CallExpression[callee.property.name=/^(del|unlink)$/] > SpreadElement.arguments',
		message: REDIS_DEL_MESSAGE
	}
]

/*
 * Revised by the approval-gate fix. `waitApprov` used to be banned here in all four shapes,
 * on the reasoning that no BC-01 service had any business naming BC-03's field. That reasoning had a
 * hole in it: nothing read the flag anywhere on the platform, so an admin parking a shop owner
 * pending review changed nothing — the account logged in and kept working. The gate now reads it, so
 * a rule forbidding the read would forbid the fix.
 *
 * What stays refused is the *write*, and an object-literal key is the shape a `$set` is built from —
 * a ShopOwner-tier service able to raise or clear this flag could approve its own account, which was
 * always the real point. Reading it can only make this service refuse to serve itself.
 *
 * Scoped to `src/**` where it is used below, because a test proving the gate bites has to construct
 * the parked state and a fixture is a `Property` too. The constant is APPROVAL_GATE_FIELD_SHOP_OWNER
 * in marketplace-common, whose schema-path test is what catches a rename of the field.
 */
const WAIT_APPROV_NO_WRITE = {
	selector: "Property[key.name='waitApprov']",
	message:
		"`shopOwner.waitApprov` is BC-03's to write, never this tier's — a service that could raise or clear the approval flag could approve its own account. Reading it is what checkShopOwnerApproval in marketplace-common does, and both BC-01 gates call it. The constant is APPROVAL_GATE_FIELD_SHOP_OWNER."
}

/*
 * The pair ADR-034 replaced, refused by name so that "nothing reads them" stops being a claim
 * about how the code happens to be written today. The signing keys are one Redis record wrapped under
 * KEYGRIP_KEK; a service that read KEYGRIP_KEY_1 out of its environment again would sign cookies with a
 * key its siblings do not have, and the failure is a browser that is silently logged out rather than an
 * error anybody sees.
 *
 * Two selectors because `process.env.X` parses as an Identifier and `process.env['X']` as a Literal —
 * the same reason the NODE_TLS_REJECT_UNAUTHORIZED pair below carries two. Both are anchored on
 * `process.env` rather than on the bare name: KEYGRIP_KEY_BYTES is a live constant in
 * marketplace-common, and a rule matching the prefix everywhere would refuse it.
 *
 * Scoped to `src/**` where it is used below: test/index.unit.test.mts asserts these very names are
 * absent from REQUIRED_ENV_VARS, and a repo-wide ban would refuse the test that proves the story.
 */
const KEYGRIP_KEY_NO_ENV_READ = [
	{
		selector: "MemberExpression[object.object.name='process'][object.property.name='env'][property.name=/^KEYGRIP_KEY_/]",
		message:
			'KEYGRIP_KEY_1/KEYGRIP_KEY_2 are gone since ADR-034. The cookie-signing keys are the Redis record at <REDIS_KEY>keygrip, unwrapped with KEYGRIP_KEK by loadKeygrip in marketplace-common — an env read here signs cookies the other services cannot verify.'
	},
	{
		selector: "MemberExpression[object.object.name='process'][object.property.name='env'][property.value=/^KEYGRIP_KEY_/]",
		message:
			'KEYGRIP_KEY_1/KEYGRIP_KEY_2 are gone since ADR-034. The cookie-signing keys are the Redis record at <REDIS_KEY>keygrip, unwrapped with KEYGRIP_KEK by loadKeygrip in marketplace-common — an env read here signs cookies the other services cannot verify.'
	}
]

/*
 * ADR-044. Suspension is the admin's instrument end to end: the Admin tier raises it, and the Admin
 * tier is the only hand that lifts it — *"if admin suspend an account, admin must remove the suspension
 * for allow the shopowner to log in again"*. A ShopOwner-tier service able to write any `disabled*`
 * field could clear a sanction standing against the very account whose token it is renewing, which is
 * the argument `WAIT_APPROV_NO_WRITE` above makes one field over, and it earns the same lock.
 *
 * ⚠️ **A write ban, not a ban, and here that is not a nicety.** This service reads the flag: the
 * refresh projection in `tokenInfoShopOwner` carries `disabled`, `findAccountForSession` re-runs
 * `checkUserAuthorizationDisDel` over it on every refresh, and that read is what ends a suspended
 * owner's session within one access-token lifetime. A rule refusing the read would refuse the
 * enforcement. Hence four write shapes and no read shape: the object-literal key a `$set` is built
 * from, the same key quoted, and both assignment forms (`owner.disabled = false`,
 * `owner['disabled'] = false`), which is the shape the telemetry audit actually found for
 * `rejectUnauthorized` and which a `Property`-only rule passes.
 *
 * `ObjectExpression >` rather than a bare `Property`, because an `ObjectPattern` is a `Property` too and
 * destructuring the flag off a document that was just read is a read. The collateral this accepts is the
 * object form of a Mongoose projection — `.select({ disabled: 1 })` is indistinguishable from a `$set`
 * at this level and is refused with it. Nothing here uses that form: every projection in this service is
 * the space-separated string, which no selector below touches.
 *
 * The three names are `shopOwner`'s real ones, from `BEs/marketplace-db-setup/lib/schemas/account.js`.
 * There is no `disabledAt` — ADR-044 names one in prose as a shape it would also cover, and the schema
 * never grew it, so banning the name would be banning nothing.
 *
 * Scoped to `src/**` where it is used below: a test proving the gate refuses a suspended owner has to
 * construct that owner, and a fixture is an object literal like any other.
 */
const DISABLED_NO_WRITE = [
	{
		selector:
			'ObjectExpression > Property[key.name=/^disabled(By|Reason)?$/], ObjectExpression > Property[key.value=/^disabled(By|Reason)?$/], AssignmentExpression[left.property.name=/^disabled(By|Reason)?$/], AssignmentExpression[left.property.value=/^disabled(By|Reason)?$/]',
		message:
			"ADR-044: `disabled`, `disabledBy` and `disabledReason` are the Admin tier's to write, never this tier's — a service that could raise or clear a suspension could lift a sanction standing against itself, and the platform owner's ruling is that only an admin removes one. A self-service closure stamps `deleted` and stops. The reads stay legal: checkUserAuthorizationDisDel at login and findAccountForSession on every refresh are what enforce the flag."
	}
]

/* Hoisted so both config objects below can share it — see the note above the second one. */
const RESTRICTED_SYNTAX = [
	{
		selector: "AssignmentExpression[left.property.name='rejectUnauthorized']",
		message:
			'certificate verification stays on. Trust the collector CA from outside the process — NODE_EXTRA_CA_CERTS=/path/to/ca.pem — as the parent workspace SETUP.md §7 describes.'
	},
	{
		selector: "Property[key.name='rejectUnauthorized']",
		message:
			'certificate verification stays on. Trust the collector CA from outside the process — NODE_EXTRA_CA_CERTS=/path/to/ca.pem — as the parent workspace SETUP.md §7 describes.'
	},
	{
		selector: "Property[key.value='rejectUnauthorized']",
		message:
			'certificate verification stays on. Trust the collector CA from outside the process — NODE_EXTRA_CA_CERTS=/path/to/ca.pem — as the parent workspace SETUP.md §7 describes.'
	},
	{
		selector: "Property[key.name='sendDefaultPii']",
		message:
			'the blanket Sentry PII flag is absent by decision, not set to false. Name the individual dataCollection categories instead — the observability section of docs/architecture.md says which, and why.'
	},
	// Two settings one word from being reversed, with nothing else that would
	// notice. `!=` rather than a positive match because the shape to refuse is *any other
	// value*, including the `'medium'` the SDK falls back to when the key is dropped entirely —
	// and the pair selector uses `:has(> …)` so that an unrelated nested object carrying a
	// `beforeSend` cannot satisfy it on the outer literal's behalf.
	{
		selector: "Property[key.name='maxIncomingRequestBodySize'][value.value!='none']",
		message:
			"the request body is never captured. `maxIncomingRequestBodySize: 'none'` is the only gate on it — `dataCollection.httpBodies` reaches the span attribute and not the event, which is how a plaintext password was measured on the wire."
	},
	{
		selector: "ObjectExpression:has(> Property[key.name='beforeSend']):not(:has(> Property[key.name='beforeSendTransaction']))",
		message:
			'`beforeSend` and `beforeSendTransaction` are wired together or not at all. The SDK routes transaction events to the second hook only, and the client address is on the transaction — one hook without the other means a `tracesSampleRate` switches the redaction off.'
	},
	{
		selector: "MemberExpression[property.name='NODE_TLS_REJECT_UNAUTHORIZED']",
		message:
			'certificate verification stays on. Trust the collector CA from outside the process — NODE_EXTRA_CA_CERTS=/path/to/ca.pem — as the parent workspace SETUP.md §7 describes.'
	},
	{
		selector: "Literal[value='NODE_TLS_REJECT_UNAUTHORIZED']",
		message:
			'certificate verification stays on. Trust the collector CA from outside the process — NODE_EXTRA_CA_CERTS=/path/to/ca.pem — as the parent workspace SETUP.md §7 describes.'
	},
	// The `shopOwner` field the Admin tier owns outright, refused here so that "no
	// ShopOwner-tier service selects it" stops being a claim about how the code happens to be
	// written today. `notes` is free text an admin wrote *about* a named person, encrypted at rest
	// and the one encrypted field on the platform whose subject never gets to read it. The approval
	// gate `waitApprov` used to sit here beside it and no longer does — see `WAIT_APPROV_NO_WRITE`
	// above for what replaced it and why a read had to become legal.
	//
	// The list and the whole argument live on `ADMIN_ONLY_FIELDS_SHOP_OWNER` in
	// `marketplace-common` — including why this is a lint rule and not an anti-corruption layer.
	// ⚠️ The name is duplicated from it rather than imported: an `import` here would make every
	// `yarn lint` in this repo depend on a built, deployed `dist/` next door. What keeps the copies
	// honest is the test in that repo asserting the name still resolves to a real path on
	// `ShopOwnerSchema`, so a rename fails in the repo that owns the shape rather than silently
	// leaving three selectors pointing at a field that no longer exists.
	//
	// Four shapes, because the projection is the one that matters and it is none of the other three:
	// a Mongoose projection is a single space-separated string, where the field name is neither a key
	// nor a member — hence `Literal` with a word-bounded regex rather than a bare substring, which
	// would also fire on any prose mentioning the field. `TSPropertySignature` is the step before it,
	// where the interface the projection is typed against grows the field first.
	{
		selector:
			"Property[key.name='notes'], TSPropertySignature[key.name='notes'], MemberExpression[property.name='notes'], Literal[value=/(^|\\s)notes(\\s|$)/]",
		message:
			"`shopOwner.notes` is the Admin tier's. It is what an admin wrote about this shop owner, and the subject never reads it — no BC-01/ShopOwner-tier service selects, projects, types or returns it. The list is ADMIN_ONLY_FIELDS_SHOP_OWNER in marketplace-common."
	}
]

/*
 * ADR-012, and the one thing holding the two-level category cap up.
 *
 * The cap is enforced in a resolver — `throwIfParentNotTopLevel`, in
 * `marketplace-dev-admin-authenticated-resource` — and not in the collection's `$jsonSchema`, because a
 * validator cannot read a second document to find out how deep the one in front of it sits. That is a
 * MongoDB limit rather than a design preference, and ADR-012 accepts it. What it costs is that the cap
 * holds exactly as long as every write to `itemCategory` goes through the four functions that call the
 * check. A write added on any other tier is a third level with nothing to refuse it, and nothing
 * structural noticed. RISK_REGISTER R19.
 *
 * Two selectors for the call rather than one: `ItemCategory.updateOne(...)` and
 * `ItemCategory['updateOne'](...)` are the same write, and a `property.name` rule passes the second — the
 * same `key.name` / `key.value` split the TLS selectors above already carry. A third for the import,
 * because both call selectors are keyed on the identifier and an alias would rename the model out of
 * their reach.
 *
 * ⚠️ **A write ban, not a ban.** The read verbs are absent on purpose: `throwIfItemCategoryMissing`
 * counts, the catalogue resolvers query, and a rule refusing those would refuse the tier's own work.
 */
const ITEMCATEGORY_NO_WRITE = [
	{
		selector:
			"CallExpression[callee.object.name='ItemCategory'][callee.property.name=/^(bulkWrite|create|deleteMany|deleteOne|findOneAndDelete|findOneAndReplace|findOneAndUpdate|insertMany|replaceOne|updateMany|updateOne)$/]",
		message:
			'ADR-012: `itemCategory` is written by marketplace-dev-admin-authenticated-resource and by nothing else. The two-level cap is enforced there, in `throwIfParentNotTopLevel`, because a `$jsonSchema` validator cannot read the parent document to learn how deep this one sits — a MongoDB limit rather than a preference — so a write from any other tier is a third level with nothing left to refuse it. Reads are untouched: `aggregate`, `countDocuments`, `find` and `findOne` are deliberately absent from this list, because the category query resolvers are what the tier exists for.'
	},
	{
		selector:
			"CallExpression[callee.object.name='ItemCategory'][callee.property.value=/^(bulkWrite|create|deleteMany|deleteOne|findOneAndDelete|findOneAndReplace|findOneAndUpdate|insertMany|replaceOne|updateMany|updateOne)$/]",
		message:
			'ADR-012: `itemCategory` is written by marketplace-dev-admin-authenticated-resource and by nothing else. The two-level cap is enforced there, in `throwIfParentNotTopLevel`, because a `$jsonSchema` validator cannot read the parent document to learn how deep this one sits — a MongoDB limit rather than a preference — so a write from any other tier is a third level with nothing left to refuse it. Reads are untouched: `aggregate`, `countDocuments`, `find` and `findOne` are deliberately absent from this list, because the category query resolvers are what the tier exists for.'
	},
	{
		selector: "ImportSpecifier[imported.name='ItemCategory'][local.name!='ItemCategory']",
		message:
			'ADR-012: import the itemCategory model under its own name. The two selectors above are keyed on the identifier `ItemCategory`, so `import { ItemCategory as Categories }` renames the model out of their reach and the ban with it. A rename that buys nothing is refused rather than left standing as the one way through.'
	}
]

/*
 * ADR-031-era convention made mechanical: an integration test seeds through the raw driver, never
 * through a Mongoose model. RISK_REGISTER R33, docs/testing.md "Integration test conventions".
 *
 * A model is a second description of a collection whose first description is the `$jsonSchema`
 * validator in `marketplace-db-setup` — `ShopOwner` once declared a bare `personalData.birth.date`
 * and no `contacts` at all while the validator demanded both. A suite that seeds through the model
 * then writes a document the collection would have refused, and passes: the per-repo throwaway
 * databases carry no validator, so nothing on the way in says no. The raw driver has no opinion of
 * its own, which is the whole point — the literal in the test is the document under test.
 *
 * Scoped to `test/integration/**` on purpose. Unit tests mock these models by name and must keep
 * importing them, and `marketplace-common`'s own suite tests the models themselves.
 */
const INTEGRATION_SEED_NO_MODEL = {
	patterns: [
		{
			group: ['@axiumine/marketplace-common/models/MongoDB/*'],
			message:
				'An integration test seeds through the raw driver — `mongoose.connection.db!.collection(...)` — and never through a Mongoose model. A model can diverge from the collection\'s $jsonSchema validator (ShopOwner did), so a model-shaped seed writes a document this suite never described. Testing a model belongs in marketplace-common. docs/testing.md "Integration test conventions", RISK_REGISTER R33.'
		}
	]
}

export default [
	// `.stryker-tmp/**` and `reports/**` are build output, not sources. Stryker copies the whole
	// repo into a sandbox under .stryker-tmp and only removes it on a clean exit — an interrupted
	// run leaves one behind, and eslint then lints a second copy of every test file. Those copies
	// carry `@ts-nocheck` and sit outside every tsconfig, so the lint fails with dozens of errors
	// that point at a directory .gitignore already ignores.
	// `.qodana/**` is what `--results-dir` writes: a SARIF file and a bundled HTML report whose
	// minified browser JS is someone else's code. The root-JS block at the bottom of this file is
	// scoped tightly enough that none of it is reachable anyway — this entry is the second lock.
	{ ignores: ['dist/**', 'coverage/**', '.stryker-tmp/**', 'reports/**', '.qodana/**'] },
	...eslintConfig,
	{
		files: ['test/**/*.mts', 'vitest.*.mts'],
		languageOptions: {
			parser: tsParser,
			parserOptions: { ecmaVersion: 'latest', sourceType: 'module' }
		},
		plugins: sharedTsBlock.plugins,
		rules: sharedTsBlock.rules
	},
	// The root-level JS config files — this file and stryker.config.mjs. The shared config's JS block
	// is scoped to `src/**/*.{js,cjs,mjs}`, and a service whose sources are all .mts has no JS under
	// src/ at all, so without this block the two files that decide how everything else is linted and
	// mutated are themselves checked by nothing while `yarn lint:check` reports green.
	//
	// `marketplace-dev-public-resource` was the only repo that noticed: it carried a `.eslintrc.json`
	// declaring exactly this intent — eslint:recommended plus simple-import-sort, node, `*.mjs` as
	// module — and it never once ran. eslintrc was already inert under eslint 9's flat-config default,
	// and eslint 10 (`^10.8.0` here) dropped the format outright, so the file was decoration. It is
	// deleted; this block is what it meant to be, and it lives in all seven services and in
	// marketplace-common because the gap was never specific to the one repo that documented it.
	//
	// `*.js` in flat config matches the config file's own directory only — it is NOT expanded to
	// `**/*.js`. That is the whole reason this is safe: a repo-wide JS block would also pick up the
	// minified browser bundle Qodana writes under .qodana/ and any leftover .stryker-tmp/ sandbox,
	// which is precisely how marketplace-admin's config arrived at 1600 `no-undef` errors. Both paths are
	// in the `ignores` above as well — belt and braces, since the glob alone already excludes them.
	//
	// No `globals` entry: neither root file references a node global. Every `process` and `module`
	// that greps out of stryker.config.mjs across these repos is inside a comment. Add one here if
	// that stops being true — do not reach for a wider glob.
	{
		files: ['*.js', '*.mjs', '*.cjs'],
		languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
		plugins: { 'simple-import-sort': simpleImportSort },
		rules: {
			...js.configs.recommended.rules,
			'simple-import-sort/imports': 'error',
			'simple-import-sort/exports': 'error'
		}
	},
	// Neither setting the telemetry audit removed can come back by accident.
	//
	// Core `no-restricted-syntax`, in this file rather than in `@axiumine/eslint-config-be`: the shared
	// package is a repo outside these sixteen and ships to unrelated consumers, so a Sentry-specific rule
	// there would cost a publish, a version bump in ten dependents, and a rule everyone else carries for
	// nothing. One block duplicated into ten repos is the cheaper half of that trade, and it follows the
	// idiom the two blocks above already established.
	//
	// No `files` key on the first object, so the shared entries apply to every file eslint looks at
	// here; the second one narrows to src/** and adds the three bans that belong there alone. Three selectors for
	// `rejectUnauthorized` because the defect actually in the tree was an assignment
	// (`options.rejectUnauthorized = false`), not an object literal — a `Property`-only rule passes the
	// exact code it exists to catch — and the computed form has a `key.value` where the plain one has a
	// `key.name`. Two for `NODE_TLS_REJECT_UNAUTHORIZED` for the same reason one level up:
	// `process.env.X` parses as an Identifier, `process.env['X']` as a Literal, and a rule carrying one
	// misses the other.
	{
		rules: {
			'no-restricted-syntax': ['error', ...REDIS_ONE_KEY_PER_DEL, ...RESTRICTED_SYNTAX, ...ITEMCATEGORY_NO_WRITE]
		}
	},
	// The write ban rides on top of the shared entries rather than replacing them: a second config
	// object naming the same rule discards the first one's options for every file it matches, so
	// dropping the spread would silently un-ban `notes` and every Sentry selector inside src/**.
	{
		files: ['src/**/*.mts'],
		rules: {
			'no-restricted-syntax': [
				'error',
				...REDIS_ONE_KEY_PER_DEL,
				...RESTRICTED_SYNTAX,
				...ITEMCATEGORY_NO_WRITE,
				WAIT_APPROV_NO_WRITE,
				...KEYGRIP_KEY_NO_ENV_READ,
				...DISABLED_NO_WRITE
			]
		}
	},
	// The seeding convention, stated where it can fail. Nothing else in this file names
	// `no-restricted-imports`, so this object is the whole rule for the files it matches — add to
	// `INTEGRATION_SEED_NO_MODEL` rather than declaring the rule a second time.
	{
		files: ['test/integration/**/*.mts'],
		rules: {
			'no-restricted-imports': ['error', INTEGRATION_SEED_NO_MODEL]
		}
	}
]
