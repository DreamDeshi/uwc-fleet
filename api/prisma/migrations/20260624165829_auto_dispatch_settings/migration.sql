-- CreateEnum
CREATE TYPE "DispatchMode" AS ENUM ('manual', 'auto');

-- CreateTable
CREATE TABLE "AppSetting" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "dispatch_mode" "DispatchMode" NOT NULL DEFAULT 'manual',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("id")
);
