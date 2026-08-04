import { GraphQLObjectType } from 'graphql'

import { helloRefresh } from './queries/helloRefresh.mjs'

const QueriesApi = new GraphQLObjectType({
	name: 'QueriesApi',
	fields: {
		helloRefresh
	}
})

export default QueriesApi
