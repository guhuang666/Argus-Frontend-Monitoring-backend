-- AlterTable
ALTER TABLE "alert_events" ADD COLUMN     "metric" VARCHAR(30),
ADD COLUMN     "threshold" DOUBLE PRECISION,
ADD COLUMN     "window_minutes" INTEGER;

-- CreateIndex
CREATE INDEX "alert_events_rule_id_fired_at_idx" ON "alert_events"("rule_id", "fired_at" DESC);
