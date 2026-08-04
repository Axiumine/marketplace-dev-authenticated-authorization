import { TCommonHeaders } from '@axiumine/koa-utils/graphQL/schema/context/TCommonHeaders'
import { ICookies } from '@axiumine/koa-utils/lib/ICookies'
import { IRedisDataShopOwner } from '@thedoctorweb_agency/marketplace-common/others/Redis/IRedisDataShopOwner'
import { IncomingHttpHeaders } from 'http'

interface IRedisDataShopOwnerForNode extends IRedisDataShopOwner {
	refreshToken: string
}

type IStateApi = {
	user: IRedisDataShopOwnerForNode
}
export type IContextAuthenticatedAuthorization = {
	state: IStateApi
	cookies: ICookies
	request: {
		header?: TCommonHeaders & IncomingHttpHeaders
	}
}
