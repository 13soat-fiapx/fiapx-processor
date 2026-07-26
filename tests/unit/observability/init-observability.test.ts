import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { config } from "../../../src/config";
import {
  initObservability,
  isObservabilityEnabled,
  shutdownObservability,
} from "../../../src/shared/observability";

const originalConfig = { ...config };

function setDatadogConfig(overrides: Partial<typeof config>) {
  Object.assign(config, overrides);
}

let logSpy: ReturnType<typeof spyOn<Console, "log">>;

beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  Object.assign(config, originalConfig);
  // Short budget: the fake endpoint is unreachable, so every flush is expected to time out.
  await shutdownObservability(200);
  logSpy.mockRestore();
});

/** The resource is only reachable through an emitted span, which is also the honest check. */
async function captureResourceAttributes() {
  const span = trace.getTracer("FiapX").startSpan("resource-probe");
  span.end();
  return (span as unknown as { resource: { attributes: Record<string, unknown> } }).resource
    .attributes;
}

describe("initObservability guard", () => {
  test.each([
    ["the api key is empty", { datadogApiKey: "" }],
    ["the api key is blank", { datadogApiKey: "   " }],
    ["the OTLP endpoint is empty", { datadogApiKey: "key", datadogOtlpEndpoint: "" }],
  ])("disables observability when %s", (_label, overrides) => {
    setDatadogConfig({
      datadogApiKey: "key",
      datadogOtlpEndpoint: "http://127.0.0.1:9",
      ...overrides,
    });

    initObservability();

    expect(isObservabilityEnabled()).toBe(false);
    expect(logSpy.mock.calls.flat().join(" ")).toContain("Datadog observability disabled");
  });

  test("registers the three signals when the api key and endpoint are configured", () => {
    setDatadogConfig({ datadogApiKey: "key", datadogOtlpEndpoint: "http://127.0.0.1:9" });

    initObservability();

    expect(isObservabilityEnabled()).toBe(true);
    expect(logSpy.mock.calls.flat().join(" ")).not.toContain("Datadog observability disabled");
    expect(trace.getTracer("FiapX").startSpan("probe").isRecording()).toBe(true);
    expect(metrics.getMeter("FiapX").createCounter("probe")).toBeDefined();
    expect(logs.getLoggerProvider().getLogger("FiapX")).toBeDefined();
    expect(propagation.fields()).toContain("traceparent");
  });

  test("is idempotent", () => {
    setDatadogConfig({ datadogApiKey: "key", datadogOtlpEndpoint: "http://127.0.0.1:9" });

    initObservability();
    const provider = trace.getTracerProvider();
    initObservability();

    expect(trace.getTracerProvider()).toBe(provider);
  });
});

describe("initObservability resource", () => {
  test("composes the service identity from the app config", async () => {
    setDatadogConfig({
      datadogApiKey: "key",
      datadogOtlpEndpoint: "http://127.0.0.1:9",
      appName: "processor",
      appVersion: "9.9.9",
      environment: "staging",
    });

    initObservability();

    const attributes = await captureResourceAttributes();

    expect(attributes["service.name"]).toBe("fiapx-processor");
    expect(attributes["service.version"]).toBe("9.9.9");
    expect(attributes["deployment.environment"]).toBe("staging");
  });

  test("falls back to the config defaults", async () => {
    setDatadogConfig({ datadogApiKey: "key", datadogOtlpEndpoint: "http://127.0.0.1:9" });

    initObservability();

    const attributes = await captureResourceAttributes();

    expect(attributes["service.name"]).toBe(`fiapx-${originalConfig.appName}`);
    expect(attributes["service.version"]).toBe(originalConfig.appVersion);
    expect(attributes["deployment.environment"]).toBe(originalConfig.environment);
  });
});

describe("shutdownObservability", () => {
  test("tears the providers down and can run twice", async () => {
    setDatadogConfig({ datadogApiKey: "key", datadogOtlpEndpoint: "http://127.0.0.1:9" });
    initObservability();

    await shutdownObservability(200);

    expect(isObservabilityEnabled()).toBe(false);
    expect(trace.getTracer("FiapX").startSpan("probe").isRecording()).toBe(false);

    await shutdownObservability(200);
  });

  test("is a no-op when observability was never enabled", async () => {
    setDatadogConfig({ datadogApiKey: "" });
    initObservability();

    await shutdownObservability(200);

    expect(context.active()).toBeDefined();
  });
});
