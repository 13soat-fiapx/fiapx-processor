
import { t, type UnwrapSchema } from 'elysia'

export const BrokerModel = {
	brokerRequest: t.Object({
		videoId: t.String(),
	}),
	brokerResponse: t.Object({
		message: t.String(),
	}),
	brokerInvalid: t.Literal('Invalid frame')
} as const

export type BrokerModel = {
	[k in keyof typeof BrokerModel]: UnwrapSchema<typeof BrokerModel[k]>
}