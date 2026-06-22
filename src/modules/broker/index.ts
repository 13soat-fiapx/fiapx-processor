import Elysia from "elysia"
import { BrokerModel } from "./model"
import { Broker } from "./service"


export const broker = new Elysia({ prefix: '/video' })
  .post(
    '/process',
    async ({ body }) => {

      await Broker.sendFrame(body)

      return {
        message: 'Frame received successfully'
      }
    }, {
      body: BrokerModel.brokerRequest,
      response: {
        202: BrokerModel.brokerResponse,
        400: BrokerModel.brokerInvalid
      }
    }

  )