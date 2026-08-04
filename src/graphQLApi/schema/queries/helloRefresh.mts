import Hello2Type from '@ptypes/Hello2Type.mjs'
import { GraphQLNonNull } from 'graphql'

export const helloRefresh = {
	description: 'helloRefresh',
	type: new GraphQLNonNull(Hello2Type),
	resolve() {
		return {
			txt: `Hello from helloRefresh`
		}
	}
}
