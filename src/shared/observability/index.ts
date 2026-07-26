import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { config } from "../../config";
import { SERVICE_PREFIX } from "./telemetry";

/**
 * `deployment.environment` is spelled out instead of using the semantic-conventions constant:
 * newer semconv releases renamed it to `deployment.environment.name`, and the .NET services
 * (fiapx-api, fiapx-notifier) emit the old key. Cross-service grouping in Datadog depends on
 * all three agreeing.
 */
const ATTR_DEPLOYMENT_ENVIRONMENT = "deployment.environment";

const FLUSH_TIMEOUT_MS = 5_000;

let tracerProvider: BasicTracerProvider | undefined;
let meterProvider: MeterProvider | undefined;
let loggerProvider: LoggerProvider | undefined;

export function isObservabilityEnabled() {
  return tracerProvider !== undefined;
}

/**
 * Registers the three OTLP signals against the Datadog intake. Must be the first call of the
 * entrypoint, before any instrumented module runs.
 *
 * Guard: with no API key (or no endpoint) nothing is registered and the global API stays a
 * no-op, so local runs never leak telemetry and the service starts normally.
 */
export function initObservability() {
  if (isObservabilityEnabled()) {
    return;
  }

  const apiKey = config.datadogApiKey.trim();
  let endpoint = config.datadogOtlpEndpoint.trim();
  while (endpoint.endsWith("/")) {
    endpoint = endpoint.slice(0, -1);
  }

  if (!apiKey || !endpoint) {
    console.log("Datadog observability disabled: api key or OTLP endpoint not configured");
    return;
  }

  const headers = { "dd-api-key": apiKey };

  const resource = defaultResource().merge(
    resourceFromAttributes({
      [ATTR_SERVICE_NAME]: `${SERVICE_PREFIX}${config.appName}`,
      [ATTR_SERVICE_VERSION]: config.appVersion,
      [ATTR_DEPLOYMENT_ENVIRONMENT]: config.environment,
    }),
  );

  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  tracerProvider = new BasicTracerProvider({
    resource,
    sampler: new AlwaysOnSampler(),
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: `${endpoint}/v1/traces`,
          // Without compute_stats the direct intake does not compute trace metrics.
          headers: { ...headers, compute_stats: "true" },
        }),
      ),
    ],
  });
  trace.setGlobalTracerProvider(tracerProvider);

  meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: `${endpoint}/v1/metrics`,
          headers,
          // The intake rejects cumulative metrics; the SDK default is cumulative.
          temporalityPreference: AggregationTemporality.DELTA,
        }),
      }),
    ],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({ url: `${endpoint}/v1/logs`, headers }),
      }),
    ],
  });
  logs.setGlobalLoggerProvider(loggerProvider);
}

/**
 * Flushes and tears down the three providers. Mandatory in the KEDA ScaledJob: the batch
 * processors export on a timer, so without an explicit flush the whole job's telemetry is lost
 * when the process exits. Never throws — a telemetry failure must not fail the job.
 */
export async function shutdownObservability(timeoutMs = FLUSH_TIMEOUT_MS) {
  const providers = [tracerProvider, meterProvider, loggerProvider].filter(
    (provider) => provider !== undefined,
  );

  tracerProvider = undefined;
  meterProvider = undefined;
  loggerProvider = undefined;

  // The three signals flush in parallel under a single budget: an unreachable intake must not
  // multiply the job's shutdown time by the number of providers.
  for (const phase of ["forceFlush", "shutdown"] as const) {
    if (providers.length === 0) break;

    try {
      await withTimeout(
        Promise.all(providers.map((provider) => provider[phase]())).then(() => undefined),
        timeoutMs,
      );
    } catch (error) {
      console.error({ error, phase }, "failed to flush telemetry on shutdown");
    }
  }

  trace.disable();
  metrics.disable();
  logs.disable();
  context.disable();
  propagation.disable();
}

function withTimeout(promise: Promise<void>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout>;

  const timeout = new Promise<void>((_, reject) => {
    timer = setTimeout(() => reject(new Error("telemetry flush timed out")), timeoutMs);
  });

  // The timer must be cleared, otherwise a fast flush still holds the event loop open.
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
