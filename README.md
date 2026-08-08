# marketplace-dev-authenticated-authorization

Token lifecycle for the **shop-owner** tier — `ShopOwner`. Port **4029**, endpoint
`/authenticated-authorization`, one mutation: `refresh`.

No business queries live here; those are in `marketplace-dev-authenticated-resource` (4026). Logout is not
here either — `marketplace-dev-authenticated-logout` (4030) serves all three tiers, because it deletes
sessions by token content and never asks which collection minted them.

## Why so little code is in this repo

Most of this service's body lives in `marketplace-common`, and has since 4.4.0.

The three `*-authenticated-authorization` services were byte-identical apart from a tier constant, a model
and a projection. On 2026-08-07 the shared part moved into `resolveAuthorizationSession`,
`findAccountForSession` and `refreshSessionTokens`, while the three services, three ports and three crash
domains stayed exactly as they were. The survey behind that choice — including the two options that were
rejected and why — is `docs/decisions/authorization-service-consolidation.md` in the parent workspace.

Both directions are closed. The helpers are not to be re-inlined, and the three services are not to be
merged into one: the merge is a decision the user has already taken, against.

## What remains here

What is still this repo's is the whole of what makes it the ShopOwner tier:

- `TIER.shopOwner`, hardcoded at the one `resolveAuthorizationSession` call.
- `tokenInfoShopOwner`'s projection: `login.firstLogin`, `login.onboardingStep` and `login.onboardingDone`
  on top of the three fields every tier reads. A shop owner is walked through a multi-step onboarding an
  operator can interrupt; neither of the other two tiers has one.
- `makeOnboardingData`, and the `onboardingStep` it may add to the session. The field is omitted rather
  than set to `undefined` when there is no step: the session is written to a Redis hash, and `hSet` rejects
  an undefined value instead of skipping the field.
- `ctx.state.user` is typed `TAuthorizationSession<IRedisDataShopOwnerCommon>` — the helper's own return
  type, not a restatement of it. That is what lets the middleware assign the session with no cast, and what
  stops the context type and the helper drifting apart.

## Related files

| Topic | File |
|---|---|
| rules for agents working in this repo | `CLAUDE.md` |
| git hooks, gate order, node selection | `REPO.md` |
| the whole platform — tiers, ports, terminology | parent `CLAUDE.md` |
