import type { Counter, Histogram } from "@opentelemetry/api";
import { getMeter } from "./telemetry";

/**
 * Business metrics of the processor. Cardinality rule: tags only take closed-domain values
 * (`status`). Ids such as `video.id` or `userId` belong on span tags, never here.
 *
 * The instruments are resolved lazily so `initObservability()` can run before the global meter
 * provider exists — a module-level instrument would bind to the no-op provider forever.
 */
export type ProcessingStatus = "succeeded" | "failed";

let videosProcessed: Counter | undefined;
let processingDurationSeconds: Histogram | undefined;
let framesExtracted: Counter | undefined;

export const AppMetrics = {
  recordProcessed(status: ProcessingStatus) {
    videosProcessed ??= getMeter().createCounter("videos.processed");
    videosProcessed.add(1, { status });
  },

  recordProcessingDuration(seconds: number, status: ProcessingStatus) {
    processingDurationSeconds ??= getMeter().createHistogram(
      "videos.processing_duration_seconds",
    );
    processingDurationSeconds.record(seconds, { status });
  },

  recordFramesExtracted(frames: number) {
    framesExtracted ??= getMeter().createCounter("videos.frames_extracted");
    framesExtracted.add(frames);
  },
};

/** Test seam: drops the cached instruments so a fresh meter provider is picked up. */
export function resetAppMetrics() {
  videosProcessed = undefined;
  processingDurationSeconds = undefined;
  framesExtracted = undefined;
}
