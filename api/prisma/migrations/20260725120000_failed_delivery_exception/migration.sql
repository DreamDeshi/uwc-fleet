-- CreateEnum
CREATE TYPE "ExceptionCategory" AS ENUM ('customer_site', 'truck', 'cargo', 'external', 'documentation');

-- CreateEnum
CREATE TYPE "ExceptionResolution" AS ENUM ('resume', 'retry', 'reschedule', 'reassign_lorry', 'reassign_driver', 'return_cargo', 'cancel');

-- CreateEnum
CREATE TYPE "ExceptionState" AS ENUM ('reported', 'more_evidence', 'verified', 'rejected', 'resolved');

-- CreateEnum
CREATE TYPE "ExceptionActionType" AS ENUM ('report', 'request_more_evidence', 'verify', 'reject', 'resume', 'resolve');

-- CreateEnum
CREATE TYPE "ExceptionEvidenceKind" AS ENUM ('photo');

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN     "open_exception_id" TEXT;

-- CreateTable
CREATE TABLE "TripException" (
    "id" TEXT NOT NULL,
    "trip_id" TEXT NOT NULL,
    "trip_stop_id" TEXT,
    "client_occurrence_id" TEXT NOT NULL,
    "category" "ExceptionCategory" NOT NULL,
    "reason" TEXT NOT NULL,
    "reported_by" TEXT NOT NULL,
    "reported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "client_reported_at" TIMESTAMP(3),
    "current_state" "ExceptionState" NOT NULL DEFAULT 'reported',
    "resolution" "ExceptionResolution",
    "resolved_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TripException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExceptionAction" (
    "id" TEXT NOT NULL,
    "exception_id" TEXT NOT NULL,
    "client_action_id" TEXT NOT NULL,
    "type" "ExceptionActionType" NOT NULL,
    "resolution" "ExceptionResolution",
    "actor_id" TEXT NOT NULL,
    "actor_role" "Role" NOT NULL,
    "note" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "accuracy_m" DOUBLE PRECISION,
    "client_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExceptionAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExceptionEvidence" (
    "id" TEXT NOT NULL,
    "exception_id" TEXT NOT NULL,
    "action_id" TEXT,
    "client_evidence_id" TEXT NOT NULL,
    "kind" "ExceptionEvidenceKind" NOT NULL DEFAULT 'photo',
    "url" TEXT NOT NULL,
    "public_id" TEXT NOT NULL,
    "captured_client_at" TIMESTAMP(3),
    "uploaded_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExceptionEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TripException_trip_id_created_at_idx" ON "TripException"("trip_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "TripException_trip_id_client_occurrence_id_key" ON "TripException"("trip_id", "client_occurrence_id");

-- CreateIndex
CREATE INDEX "ExceptionAction_exception_id_created_at_idx" ON "ExceptionAction"("exception_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ExceptionAction_exception_id_client_action_id_key" ON "ExceptionAction"("exception_id", "client_action_id");

-- CreateIndex
CREATE INDEX "ExceptionEvidence_exception_id_idx" ON "ExceptionEvidence"("exception_id");

-- CreateIndex
CREATE UNIQUE INDEX "ExceptionEvidence_exception_id_client_evidence_id_key" ON "ExceptionEvidence"("exception_id", "client_evidence_id");

-- CreateIndex
CREATE UNIQUE INDEX "Trip_open_exception_id_key" ON "Trip"("open_exception_id");

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_open_exception_id_fkey" FOREIGN KEY ("open_exception_id") REFERENCES "TripException"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripException" ADD CONSTRAINT "TripException_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "Trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripException" ADD CONSTRAINT "TripException_trip_stop_id_fkey" FOREIGN KEY ("trip_stop_id") REFERENCES "TripStop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExceptionAction" ADD CONSTRAINT "ExceptionAction_exception_id_fkey" FOREIGN KEY ("exception_id") REFERENCES "TripException"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExceptionEvidence" ADD CONSTRAINT "ExceptionEvidence_exception_id_fkey" FOREIGN KEY ("exception_id") REFERENCES "TripException"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
