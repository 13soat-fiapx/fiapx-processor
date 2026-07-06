import { t, type UnwrapSchema } from "elysia";

export const ProcessingJobModel = {
  params: t.Object({
    processingJobId: t.String(),
  }),
  partialStatus: t.Object({
    processingJobId: t.String(),
    userId: t.String(),
    status: t.Union([
      t.Literal("PENDING"),
      t.Literal("PROCESSING"),
      t.Literal("COMPLETED"),
      t.Literal("FAILED"),
    ]),
    outputFileKey: t.Optional(t.String()),
    errorMessage: t.Optional(t.String()),
    createdAt: t.Optional(t.String()),
    updatedAt: t.Optional(t.String()),
  }),
  redirect: t.String(),
  notFound: t.Object({
    message: t.String(),
  }),
} as const;

export type ProcessingJobModel = {
  [K in keyof typeof ProcessingJobModel]: UnwrapSchema<
    (typeof ProcessingJobModel)[K]
  >;
};
