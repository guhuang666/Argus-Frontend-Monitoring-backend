-- CreateEnum
CREATE TYPE "error_mechanism" AS ENUM ('onerror', 'unhandledrejection', 'resource');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "quota_monthly" BIGINT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "platform" VARCHAR(20) NOT NULL DEFAULT 'browser',
    "sample_rate" DECIMAL(3,2) NOT NULL DEFAULT 1.00,
    "rate_limit_per_sec" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "error_events" (
    "event_id" VARCHAR(128) NOT NULL,
    "mechanism" "error_mechanism" NOT NULL,
    "type" VARCHAR(128) NOT NULL,
    "message" VARCHAR(2000) NOT NULL,
    "stack" TEXT,
    "source" VARCHAR(512),
    "timestamp" TIMESTAMPTZ NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "url" VARCHAR(2048) NOT NULL,
    "user_agent" VARCHAR(512) NOT NULL,
    "sdk_name" VARCHAR(64),
    "sdk_version" VARCHAR(32),
    "exception_type" VARCHAR(128),
    "exception_value" VARCHAR(2000),
    "exception_mechanism" VARCHAR(20),
    "stacktrace_raw" TEXT,
    "stacktrace_frames" JSONB,
    "user_id" VARCHAR(100),
    "session_id" VARCHAR(100),
    "release" VARCHAR(100),
    "environment" VARCHAR(50),
    "tags" JSONB,
    "extra" JSONB,
    "breadcrumbs" JSONB,

    CONSTRAINT "error_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "performance_metrics" (
    "event_id" VARCHAR(128) NOT NULL,
    "timestamp" TIMESTAMPTZ NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "url" VARCHAR(2048) NOT NULL,
    "user_agent" VARCHAR(512) NOT NULL,
    "sdk_name" VARCHAR(64),
    "sdk_version" VARCHAR(32),
    "lcp" DOUBLE PRECISION,
    "cls" DOUBLE PRECISION,
    "inp" DOUBLE PRECISION,
    "lcp_element" VARCHAR(32),
    "inp_target" VARCHAR(32),
    "inp_element" VARCHAR(32),
    "inp_phase" VARCHAR(32),
    "navigation_type" VARCHAR(32),
    "device_viewport" VARCHAR(32),
    "device_dpr" DOUBLE PRECISION,
    "connection" VARCHAR(16),
    "user_id" VARCHAR(100),
    "session_id" VARCHAR(100),
    "release" VARCHAR(100),
    "environment" VARCHAR(50),

    CONSTRAINT "performance_metrics_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "error_events_timestamp_idx" ON "error_events"("timestamp" DESC);

-- CreateIndex
CREATE INDEX "performance_metrics_url_timestamp_idx" ON "performance_metrics"("url", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "performance_metrics_timestamp_idx" ON "performance_metrics"("timestamp" DESC);

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
