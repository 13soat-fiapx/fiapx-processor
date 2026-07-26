import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { broker } from "../../../src/modules/broker";
import { Broker } from "../../../src/modules/broker/service";
import { processingJobs } from "../../../src/modules/processing-jobs";
import { ProcessingJobService } from "../../../src/modules/processing-jobs/service";
import { buildJobStatus } from "../../mocks/processing-jobs";

/**
 * The plugins are mounted on a throwaway app and driven through `handle`, so the routes are
 * exercised without `src/index.ts` binding port 3000 on import.
 */
const app = new Elysia().use(broker).use(processingJobs);

function get(path: string) {
  return app.handle(new Request(`http://localhost${path}`));
}

function post(path: string, body: unknown) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  mock.restore();
});

describe("GET /v1/processing-jobs/:processingJobId", () => {
  test("returns 404 when the job does not exist", async () => {
    spyOn(ProcessingJobService, "getStatus").mockResolvedValue(null);

    const response = await get("/v1/processing-jobs/missing");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Processing job not found" });
  });

  test("looks the job up by the path parameter", async () => {
    const getStatus = spyOn(ProcessingJobService, "getStatus").mockResolvedValue(buildJobStatus());

    await get("/v1/processing-jobs/job-123");

    expect(getStatus).toHaveBeenCalledWith("job-123");
  });

  // Polling clients need a hint on when to come back while the job is still in flight.
  test.each(["upload_pending", "queued", "processing"] as const)(
    "returns 200 with Retry-After while the job is %s",
    async (status) => {
      spyOn(ProcessingJobService, "getStatus").mockResolvedValue(buildJobStatus({ status }));

      const response = await get("/v1/processing-jobs/job-123");

      expect(response.status).toBe(200);
      expect(response.headers.get("Retry-After")).toBe("20");
      expect(await response.json()).toMatchObject({ processingJobId: "job-123", status });
    },
  );

  test("redirects to the file endpoint once the job succeeded with a result", async () => {
    spyOn(ProcessingJobService, "getStatus").mockResolvedValue(
      buildJobStatus({ status: "succeeded", resultFileId: "result-789" }),
    );

    const response = await get("/v1/processing-jobs/job-123");

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/v1/files/result-789");
  });

  test("escapes the result file id in the Location header", async () => {
    spyOn(ProcessingJobService, "getStatus").mockResolvedValue(
      buildJobStatus({ status: "succeeded", resultFileId: "a/b c" }),
    );

    const response = await get("/v1/processing-jobs/job-123");

    expect(response.headers.get("Location")).toBe("/v1/files/a%2Fb%20c");
  });

  test("returns the status body when the job succeeded without a result file", async () => {
    spyOn(ProcessingJobService, "getStatus").mockResolvedValue(
      buildJobStatus({ status: "succeeded" }),
    );

    const response = await get("/v1/processing-jobs/job-123");

    expect(response.status).toBe(200);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(await response.json()).toMatchObject({ status: "succeeded" });
  });

  test("returns the status body without Retry-After for a failed job", async () => {
    spyOn(ProcessingJobService, "getStatus").mockResolvedValue(buildJobStatus({ status: "failed" }));

    const response = await get("/v1/processing-jobs/job-123");

    expect(response.status).toBe(200);
    expect(response.headers.get("Retry-After")).toBeNull();
  });
});

describe("POST /video/process", () => {
  const request = {
    processingJobId: "job-123",
    userId: "user-456",
    inputFile: { key: "videos/job-123/original.mp4" },
  };

  test("publishes the request and echoes the job id with 202", async () => {
    const sendFrame = spyOn(Broker, "sendFrame").mockResolvedValue(undefined);

    const response = await post("/video/process", request);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      message: "Video processing request published successfully",
      processingJobId: "job-123",
    });
    expect(sendFrame).toHaveBeenCalledWith(expect.objectContaining(request));
  });

  test("forwards the optional fields untouched", async () => {
    const sendFrame = spyOn(Broker, "sendFrame").mockResolvedValue(undefined);

    await post("/video/process", { ...request, outputPrefix: "frames/job-123/" });

    expect(sendFrame).toHaveBeenCalledWith(
      expect.objectContaining({ outputPrefix: "frames/job-123/" }),
    );
  });

  test("rejects a body without inputFile.key without publishing", async () => {
    const sendFrame = spyOn(Broker, "sendFrame").mockResolvedValue(undefined);

    const response = await post("/video/process", {
      processingJobId: "job-123",
      userId: "user-456",
      inputFile: {},
    });

    expect(response.status).toBe(422);
    expect(sendFrame).not.toHaveBeenCalled();
  });

  test("rejects a body without processingJobId without publishing", async () => {
    const sendFrame = spyOn(Broker, "sendFrame").mockResolvedValue(undefined);

    const response = await post("/video/process", { userId: "user-456", inputFile: request.inputFile });

    expect(response.status).toBe(422);
    expect(sendFrame).not.toHaveBeenCalled();
  });
});
