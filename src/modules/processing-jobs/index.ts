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

    if (job.status === "succeeded" && job.resultFileId) {
      set.status = 303;
      set.headers.Location = `/v1/files/${encodeURIComponent(job.resultFileId)}`;
      return "";
    }

    if (job.status === "upload_pending" || job.status === "queued" || job.status === "processing") {
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
