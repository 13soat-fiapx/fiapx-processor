import Elysia from "elysia";
import { ProcessingJobModel } from "./model";
import { ProcessingJobService } from "./service";

export const processingJobs = new Elysia({ prefix: "/v1/processing-jobs" }).get(
  "/:processingJobId",
  async ({ params, set }) => {
    const job = await ProcessingJobService.getStatus(params.processingJobId);

    if (!job) {
      set.status = 404;
      return {
        message: "Processing job not found",
      };
    }

    if (job.status === "COMPLETED" && job.outputFileKey) {
      set.status = 303;
      set.headers.Location = `/v1/files/${encodeURIComponent(job.outputFileKey)}`;
      return "";
    }

    if (job.status === "PENDING" || job.status === "PROCESSING") {
      set.headers["Retry-After"] = "20";
    }

    return job;
  },
  {
    params: ProcessingJobModel.params,
    response: {
      200: ProcessingJobModel.partialStatus,
      303: ProcessingJobModel.redirect,
      404: ProcessingJobModel.notFound,
    },
    detail: {
      tags: ["Processing Jobs"],
      summary: "Get processing job status",
      description:
        "Returns the current processing status. Completed jobs redirect to the generated file endpoint.",
    },
  },
);
