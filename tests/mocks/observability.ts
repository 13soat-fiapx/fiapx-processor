import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import type { MetricData } from "@opentelemetry/sdk-metrics";
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { resetAppMetrics } from "../../src/shared/observability/app-metrics";

/**
 * In-memory equivalent of the .NET `FiapXActivityListener`/`FiapXMeterListener`: registers real
 * providers against in-memory exporters so the production code path is exercised unchanged.
 */
export function setupInMemoryTelemetry() {
  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({
    sampler: new AlwaysOnSampler(),
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });

  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(tracerProvider);

  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  const meterProvider = new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        // Collection is driven explicitly through forceFlush; the timer would only add noise.
        exportIntervalMillis: 600_000,
      }),
    ],
  });
  metrics.setGlobalMeterProvider(meterProvider);
  resetAppMetrics();

  const logExporter = new InMemoryLogRecordExporter();
  const loggerProvider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter: logExporter })],
  });
  logs.setGlobalLoggerProvider(loggerProvider);

  return {
    spans: () => spanExporter.getFinishedSpans(),
    spanNamed: (name: string) => spanExporter.getFinishedSpans().find((s) => s.name === name),
    logRecords: () => logExporter.getFinishedLogRecords(),

    async metricNamed(name: string): Promise<MetricData | undefined> {
      await meterProvider.forceFlush();

      return metricExporter
        .getMetrics()
        .flatMap((resourceMetrics) => resourceMetrics.scopeMetrics)
        .flatMap((scopeMetrics) => scopeMetrics.metrics)
        .find((metric) => metric.descriptor.name === name);
    },

    async dispose() {
      await meterProvider.shutdown();
      await loggerProvider.shutdown();
      await tracerProvider.shutdown();

      trace.disable();
      metrics.disable();
      logs.disable();
      context.disable();
      propagation.disable();
      resetAppMetrics();
    },
  };
}

export type InMemoryTelemetry = ReturnType<typeof setupInMemoryTelemetry>;
