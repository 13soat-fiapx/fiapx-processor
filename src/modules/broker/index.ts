import Elysia from "elysia"
import { BrokerModel } from "./model"
import { Broker } from "./service"


export const broker = new Elysia({ prefix: '/video' })
  .post(
    '/process',
    async ({ body, set }) => {

      await Broker.sendFrame(body)
      set.status = 202

      return {
        message: 'Video processing request published successfully',
        processingJobId: body.processingJobId,
      }
    }, {
      body: BrokerModel.brokerRequest,
      response: {
        202: BrokerModel.brokerResponse,
        400: BrokerModel.brokerInvalid
      }
    }

  )
