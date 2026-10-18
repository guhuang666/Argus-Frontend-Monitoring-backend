-- CreateTable
CREATE TABLE "releases" (
    "id" UUID NOT NULL,
    "version" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "releases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "releases_version_key" ON "releases"("version");

-- CreateTable
CREATE TABLE "sourcemap_files" (
    "id" UUID NOT NULL,
    "release_id" UUID NOT NULL,
    "artifact_path" VARCHAR(500) NOT NULL,
    "sourcemap_path" VARCHAR(500) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sourcemap_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sourcemap_files_release_id_artifact_path_key" ON "sourcemap_files"("release_id", "artifact_path");

-- AddForeignKey
ALTER TABLE "sourcemap_files" ADD CONSTRAINT "sourcemap_files_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "releases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
