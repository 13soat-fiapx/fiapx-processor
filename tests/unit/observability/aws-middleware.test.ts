import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { config } from "../../../src/config";
import {
  type InstrumentableClient,
  instrumentAwsClient,
  toOperationName,
  toServiceName,
} from "../../../src/shared/observability/aws-middleware";
import { type InMemoryTelemetry, setupInMemoryTelemetry } from "../../mocks/observability";

type Handler = (args: unknown) => Promise<unknown>;

/**
 * Minimal stand-in for an AWS SDK v3 client: captures the registered middleware and lets the
 * test drive it the way the SDK's `initialize` step would.
 */
function createFakeClient() {
  let registered: ((next: Handler, context: unknown) => Handler) | undefined;

  const client: InstrumentableClient & { registeredOptions?: unknown } = {
    middlewareStack: {
      add: (middleware, options) => {
        registered = middleware as (next: Handler, context: unknown) => Handler;
        client.registeredOptions = options;
      },
    },
  };

  return {
    client,
    optionsOf: () => (client as { registeredOptions?: unknown }).registeredOptions,
    send(next: Handler, clientName = "SQSClient", commandName = "ReceiveMessageCommand") {
      if (!registered) throw new Error("no middleware registered");
      return registered(next, { clientName, commandName })({ input: {} });
    },
  };
}

let telemetry: InMemoryTelemetry;

beforeEach(() => {
  telemetry = setupInMemoryTelemetry();
});

afterEach(async () => {
  await telemetry.dispose();
  mock.restore();
});

describe("name normalization", () => {
  test.each([
    ["SQSClient", "SQS"],
    ["DynamoDBClient", "DynamoDB"],
    [undefined, "AWS"],
  ])("maps client %s to service %s", (clientName, expected) => {
    expect(toServiceName(clientName)).toBe(expected);
  });

  test.each([
    ["ReceiveMessageCommand", "ReceiveMessage"],
    ["GetObjectCommand", "GetObject"],
    [undefined, "UnknownOperation"],
  ])("maps command %s to operation %s", (commandName, expected) => {
    expect(toOperationName(commandName)).toBe(expected);
  });
});

describe("instrumentAwsClient", () => {
  test("registers the middleware on the initialize step", () => {
    const fake = createFakeClient();

    expect(instrumentAwsClient(fake.client)).toBe(fake.client);
    expect(fake.optionsOf()).toEqual({
      step: "initialize",
      name: "fiapxObservabilityMiddleware",
      override: true,
    });
  });

  test("emits a CLIENT span with the rpc attributes and returns the result", async () => {
    const fake = createFakeClient();
    instrumentAwsClient(fake.client);

    const result = await fake.send(mock(async () => "ok"), "S3Client", "GetObjectCommand");

    const span = telemetry.spanNamed("S3 GetObject");

    expect(result).toBe("ok");
    expect(span?.kind).toBe(SpanKind.CLIENT);
    expect(span?.attributes).toEqual({
      "rpc.system": "aws-api",
      "rpc.service": "S3",
      "rpc.method": "GetObject",
      "aws.region": config.awsRegion,
    });
  });

  test("records the exception, marks the span as failed and rethrows", async () => {
    const fake = createFakeClient();
    instrumentAwsClient(fake.client);

    const failure = new Error("access denied");
    const send = fake.send(
      mock(async () => {
        throw failure;
      }),
    );

    await expect(send).rejects.toThrow("access denied");

    const span = telemetry.spanNamed("SQS ReceiveMessage");

    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.status.message).toBe("access denied");
    expect(span?.events.map((event) => event.name)).toContain("exception");
  });

  test("ends the span even when the call succeeds", async () => {
    const fake = createFakeClient();
    instrumentAwsClient(fake.client);

    await fake.send(mock(async () => undefined));

    expect(telemetry.spanNamed("SQS ReceiveMessage")?.ended).toBe(true);
  });
});
