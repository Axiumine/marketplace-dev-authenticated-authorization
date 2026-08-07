import { TCommonHeaders } from '@axiumine/koa-utils/graphQL/schema/context/TCommonHeaders'
import { ICookies } from '@axiumine/koa-utils/lib/ICookies'
import { IRedisDataShopOwnerCommon } from '@thedoctorweb_agency/marketplace-common/others/Redis/IRedisDataShopOwnerCommon'
import { TAuthorizationSession } from '@thedoctorweb_agency/marketplace-common/others/resolveAuthorizationSession'
import { IncomingHttpHeaders } from 'http'

/*
 * `ctx.state.user` is exactly what `resolveAuthorizationSession` returns — the tier-specific half of
 * the access-token hash, plus the `_id`, the `tier` and the refresh token the session was resolved
 * from. Declaring it as the helper's own return type rather than restating those three fields is
 * what lets the middleware assign the session without a cast, and what stops the two drifting: add a
 * field to the session shape and this type follows it.
 */
type IStateApi = {
	user: TAuthorizationSession<IRedisDataShopOwnerCommon>
}
export type IContextAuthenticatedAuthorization = {
	state: IStateApi
	cookies: ICookies
	request: {
		header?: TCommonHeaders & IncomingHttpHeaders
	}
}
