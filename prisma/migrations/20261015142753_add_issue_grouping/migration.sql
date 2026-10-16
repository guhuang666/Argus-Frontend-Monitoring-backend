-- AlterTable
ALTER TABLE "error_events" ADD COLUMN     "group_id" UUID,
ADD COLUMN     "processed_at" TIMESTAMPTZ;
