import { TCommonHeaders } from '@axiumine/koa-utils/graphQL/schema/context/TCommonHeaders'
import { ICookies } from '@axiumine/koa-utils/lib/ICookies'
import { IRedisDataImprenditore } from '@thedoctorweb_agency/marketplace-common/others/Redis/IRedisDataImprenditore'
import { IncomingHttpHeaders } from 'http'

interface IRedisDataImprenditoreForNode extends IRedisDataImprenditore {
	refreshToken: string
}

type IStateApi = {
	user: IRedisDataImprenditoreForNode
}
export type IContextAuthenticatedAuthorization = {
	state: IStateApi
	cookies: ICookies
	request: {
		header?: TCommonHeaders & IncomingHttpHeaders
	}
}
