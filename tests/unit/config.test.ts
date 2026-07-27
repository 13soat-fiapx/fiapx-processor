import { describe, expect, test } from "bun:test";
import {
  config,
  envOrDefault,
  getQueueName,
  getQueueNameForTelemetry,
  numberOrDefault,
} from "../../src/config";

describe("envOrDefault", () => {
  test("returns the trimmed environment value when it has content", () => {
    expect(envOrDefault("staging", "development")).toBe("staging");
    expect(envOrDefault("  staging  ", "development")).toBe("staging");
  });

  // A Helm value that renders empty must not yield `service.name: "fiapx-"` or an empty
  // deployment.environment — both would drop the service out of Datadog's grouping.
  test.each([
    ["undefined", undefined],
    ["empty", ""],
    ["blank", "   "],
  ])("falls back when the value is %s", (_label, value) => {
    expect(envOrDefault(value, "development")).toBe("development");
  });
});

describe("numberOrDefault", () => {
  test("returns the parsed number when the value is numeric", () => {
    expect(numberOrDefault("600", 10)).toBe(600);
    expect(numberOrDefault("  500000000  ", 10)).toBe(500_000_000);
  });

  test.each([
    ["undefined", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["non-numeric", "abc"],
  ])("falls back when the value is %s", (_label, value) => {
    expect(numberOrDefault(value, 42)).toBe(42);
  });
});

describe("observability config", () => {
  test("exposes a usable service identity regardless of the environment", () => {
    expect(config.appName).toBeTruthy();
    expect(config.appVersion).toBeTruthy();
    expect(config.environment).toBeTruthy();
    expect(config.environment).toBe(config.environment.toLowerCase());
    expect(config.datadogOtlpEndpoint).toStartWith("https://");
  });

  test("defaults the api key to an empty string so the guard can trip", () => {
    expect(typeof config.datadogApiKey).toBe("string");
  });
});

describe("operational limits config", () => {
  test("defaults to the values calibrated for this deployment's cluster", () => {
    expect(config.maxVideoDurationSeconds).toBe(600);
    // 314572800 bytes = 300 MiB (binary units, not decimal — matches what the OS shows).
    expect(config.maxFileSizeBytes).toBe(314_572_800);
    expect(config.ffprobePath).toBeTruthy();
  });
});

describe("getQueueName", () => {
  test("reads the queue name bound to the event type", () => {
    process.env.SQS_QUEUE_NAMES_TEST_EVENT = "fiapx-dev-test-event";

    expect(getQueueName("TEST_EVENT")).toBe("fiapx-dev-test-event");

    delete process.env.SQS_QUEUE_NAMES_TEST_EVENT;
  });

  test("throws when the binding is missing", () => {
    expect(() => getQueueName("MISSING_EVENT")).toThrow(
      "Queue name not configured: SQS_QUEUE_NAMES_MISSING_EVENT",
    );
  });
});

describe("getQueueNameForTelemetry", () => {
  test("returns the bound queue name when it is configured", () => {
    process.env.SQS_QUEUE_NAMES_TEST_EVENT = "fiapx-dev-test-event";

    expect(getQueueNameForTelemetry("TEST_EVENT")).toBe("fiapx-dev-test-event");

    delete process.env.SQS_QUEUE_NAMES_TEST_EVENT;
  });

  test("derives a readable name instead of throwing when the binding is missing", () => {
    expect(getQueueNameForTelemetry("MISSING_EVENT")).toBe("missing-event");
  });
});
