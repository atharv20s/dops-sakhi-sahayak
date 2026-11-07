-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "emergency_contact_name" VARCHAR(100),
    "emergency_contact_phone" VARCHAR(20),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "police_stations" (
    "id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "phone" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "email" VARCHAR(100) NOT NULL DEFAULT '',
    "zone" VARCHAR(50) NOT NULL DEFAULT '',
    "officer_in_charge" VARCHAR(100) NOT NULL DEFAULT '',
    "type" VARCHAR(30) NOT NULL DEFAULT 'city',
    "category" VARCHAR(30) NOT NULL DEFAULT 'station',
    "address" VARCHAR(255) NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "police_stations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "safety_reports" (
    "id" TEXT NOT NULL,
    "category" VARCHAR(50) NOT NULL,
    "locality" VARCHAR(150) NOT NULL,
    "description" TEXT NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "share_exact" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "safety_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_objects" (
    "id" UUID NOT NULL,
    "tracking_id" VARCHAR(64) NOT NULL,
    "s3_key" VARCHAR(500) NOT NULL,
    "s3_bucket" VARCHAR(100) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "file_format" VARCHAR(20) NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "mime_type" VARCHAR(50) NOT NULL,
    "user_id" UUID,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_objects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE INDEX "users_phone_idx" ON "users"("phone");

-- CreateIndex
CREATE INDEX "police_stations_lat_lng_idx" ON "police_stations"("lat", "lng");

-- CreateIndex
CREATE INDEX "police_stations_category_idx" ON "police_stations"("category");

-- CreateIndex
CREATE INDEX "safety_reports_category_idx" ON "safety_reports"("category");

-- CreateIndex
CREATE INDEX "safety_reports_created_at_idx" ON "safety_reports"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_objects_s3_key_key" ON "evidence_objects"("s3_key");

-- CreateIndex
CREATE INDEX "evidence_objects_tracking_id_idx" ON "evidence_objects"("tracking_id");

-- CreateIndex
CREATE INDEX "evidence_objects_sha256_idx" ON "evidence_objects"("sha256");

-- AddForeignKey
ALTER TABLE "evidence_objects" ADD CONSTRAINT "evidence_objects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
