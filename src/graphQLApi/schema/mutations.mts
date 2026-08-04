import { GraphQLObjectType } from 'graphql'

import { refresh } from './mutations/refresh.mjs'

const MutationsApi = new GraphQLObjectType({
	name: 'MutationsApi',
	fields: {
		refresh
	}
})

export default MutationsApi
