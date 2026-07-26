import { ROOT_CONTEXT, SpanKind, context, propagation, trace } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import { getTracer } from "./telemetry";

const MESSAGING_SYSTEM = "aws_sqs";

function withMessagingAttributes(span: Span, queueName: string) {
  span.setAttribute("messaging.system", MESSAGING_SYSTEM);
  span.setAttribute("messaging.destination.name", queueName);
  return span;
}

export function startProducerSpan(queueName: string) {
  const span = getTracer().startSpan(`${queueName} publish`, { kind: SpanKind.PRODUCER });
  return withMessagingAttributes(span, queueName);
}

/**
 * Opens the consumer span as a child of the incoming trace. Extraction is tolerant by design:
 * an absent or malformed `traceparent` yields a root span instead of an error.
 */
export function startConsumerSpan(queueName: string, traceparent?: string) {
  const parent = traceparent?.trim()
    ? propagation.extract(ROOT_CONTEXT, { traceparent })
    : ROOT_CONTEXT;

  const span = getTracer().startSpan(`${queueName} process`, { kind: SpanKind.CONSUMER }, parent);
  return withMessagingAttributes(span, queueName);
}

/**
 * W3C `traceparent` for the currently active span, or `undefined` when no SDK is registered
 * (observability disabled) or no span is active.
 */
export function currentTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent;
}

/** Runs `fn` with `span` as the active span so child spans and log records inherit it. */
export function withSpan<T>(span: Span, fn: () => T): T {
  return context.with(trace.setSpan(context.active(), span), fn);
}
