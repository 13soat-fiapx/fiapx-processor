
import { t, type UnwrapSchema } from 'elysia'

export const BrokerModel = {
	brokerRequest: t.Object({
		processingJobId: t.String(),
		userId: t.String(),
		inputFile: t.Object({
			bucket: t.Optional(t.String()),
			key: t.String(),
			region: t.Optional(t.String()),
			originalFileName: t.Optional(t.String()),
			contentType: t.Optional(t.String()),
			sizeBytes: t.Optional(t.Number()),
		}),
		outputPrefix: t.Optional(t.String()),
		requestedAt: t.Optional(t.String()),
	}),
	brokerResponse: t.Object({
		message: t.String(),
		processingJobId: t.String(),
	}),
	brokerInvalid: t.Literal('Invalid frame')
} as const

export type BrokerModel = {
	[k in keyof typeof BrokerModel]: UnwrapSchema<typeof BrokerModel[k]>
}
