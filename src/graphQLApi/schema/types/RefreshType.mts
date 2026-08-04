import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'

// returns null id if it fails to save
export const RefreshType = new GraphQLObjectType({
	name: 'RefreshType',
	fields: () => ({
		status: { type: new GraphQLNonNull(GraphQLBoolean) },
		accessToken: { type: new GraphQLNonNull(GraphQLString) }
	})
})
