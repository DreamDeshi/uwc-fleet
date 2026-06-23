-- CreateEnum
CREATE TYPE "Role" AS ENUM ('admin', 'driver', 'requestor');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('pending_approval', 'active', 'disabled');

-- CreateEnum
CREATE TYPE "TripStatus" AS ENUM ('pending', 'approved', 'rejected', 'assigned', 'in_progress', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "StopStatus" AS ENUM ('pending', 'arrived', 'delivered');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('do_photo', 'k2_form', 'other');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "refresh_token_hash" TEXT,
    "name" TEXT NOT NULL,
    "employee_number" TEXT,
    "role" "Role" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'pending_approval',
    "language_pref" TEXT NOT NULL DEFAULT 'en',
    "department_id" TEXT,
    "assigned_truck_plate" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Department" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Truck" (
    "plate" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "max_pallets" INTEGER NOT NULL,
    "entitled_claim_weekday" DECIMAL(10,2) NOT NULL,
    "entitled_claim_offpeak" DECIMAL(10,2) NOT NULL,
    "daily_deduction_points" INTEGER NOT NULL,
    "priority_zones" TEXT[],
    "operating_hours_start" TEXT NOT NULL DEFAULT '07:00',
    "operating_hours_end" TEXT NOT NULL DEFAULT '18:00',
    "insurance_expiry" TIMESTAMP(3),
    "permit_expiry" TIMESTAMP(3),
    "road_tax_expiry" TIMESTAMP(3),
    "is_available" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Truck_pkey" PRIMARY KEY ("plate")
);

-- CreateTable
CREATE TABLE "Zone" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Zone_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "RouteType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "RouteType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DestinationRate" (
    "id" TEXT NOT NULL,
    "zone_code" TEXT,
    "location_name" TEXT NOT NULL,
    "points" INTEGER NOT NULL,

    CONSTRAINT "DestinationRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trip" (
    "id" TEXT NOT NULL,
    "ticket_number" TEXT NOT NULL,
    "requestor_id" TEXT NOT NULL,
    "driver_id" TEXT,
    "truck_plate" TEXT,
    "route_type_id" TEXT NOT NULL,
    "status" "TripStatus" NOT NULL DEFAULT 'pending',
    "pickup_datetime" TIMESTAMP(3) NOT NULL,
    "incentive_earned" DECIMAL(10,2),
    "is_external" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TripStop" (
    "id" TEXT NOT NULL,
    "trip_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "consignee_id" TEXT NOT NULL,
    "status" "StopStatus" NOT NULL DEFAULT 'pending',
    "arrived_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "pod_photo" TEXT,
    "do_uploaded" BOOLEAN NOT NULL DEFAULT false,
    "k2_form_ack" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "TripStop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Consignee" (
    "id" TEXT NOT NULL,
    "company_name" TEXT NOT NULL,
    "vendor_code" TEXT,
    "contact_person" TEXT,
    "phone" TEXT,
    "address_1" TEXT,
    "address_2" TEXT,
    "area" TEXT,
    "state" TEXT,
    "postal_code" TEXT,
    "zone_code" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,

    CONSTRAINT "Consignee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CargoDetail" (
    "id" TEXT NOT NULL,
    "trip_id" TEXT NOT NULL,
    "pallet_type" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "cartons" INTEGER,
    "custom_size" TEXT,
    "remark" TEXT,

    CONSTRAINT "CargoDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TripDocument" (
    "id" TEXT NOT NULL,
    "trip_id" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL,
    "file_url" TEXT NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TripDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LocationLog" (
    "id" TEXT NOT NULL,
    "trip_id" TEXT NOT NULL,
    "driver_id" TEXT NOT NULL,
    "latitude" DECIMAL(10,7) NOT NULL,
    "longitude" DECIMAL(10,7) NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LocationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "table_name" TEXT NOT NULL,
    "record_id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleMaintenance" (
    "id" TEXT NOT NULL,
    "truck_plate" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "service_date" TIMESTAMP(3) NOT NULL,
    "cost" DECIMAL(10,2) NOT NULL,
    "next_due_date" TIMESTAMP(3),

    CONSTRAINT "VehicleMaintenance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalForwarder" (
    "id" TEXT NOT NULL,
    "trip_id" TEXT NOT NULL,
    "company_name" TEXT NOT NULL,
    "booking_date" TIMESTAMP(3) NOT NULL,
    "rate" DECIMAL(10,2) NOT NULL,
    "cargo_size" TEXT NOT NULL,

    CONSTRAINT "ExternalForwarder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FuelLog" (
    "id" TEXT NOT NULL,
    "truck_plate" TEXT NOT NULL,
    "driver_id" TEXT NOT NULL,
    "liters" DECIMAL(10,2) NOT NULL,
    "cost" DECIMAL(10,2) NOT NULL,
    "odometer" INTEGER,
    "logged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FuelLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_ZoneAdjacency" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "User_assigned_truck_plate_key" ON "User"("assigned_truck_plate");

-- CreateIndex
CREATE UNIQUE INDEX "Department_name_key" ON "Department"("name");

-- CreateIndex
CREATE UNIQUE INDEX "RouteType_name_key" ON "RouteType"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Trip_ticket_number_key" ON "Trip"("ticket_number");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalForwarder_trip_id_key" ON "ExternalForwarder"("trip_id");

-- CreateIndex
CREATE UNIQUE INDEX "_ZoneAdjacency_AB_unique" ON "_ZoneAdjacency"("A", "B");

-- CreateIndex
CREATE INDEX "_ZoneAdjacency_B_index" ON "_ZoneAdjacency"("B");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_assigned_truck_plate_fkey" FOREIGN KEY ("assigned_truck_plate") REFERENCES "Truck"("plate") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DestinationRate" ADD CONSTRAINT "DestinationRate_zone_code_fkey" FOREIGN KEY ("zone_code") REFERENCES "Zone"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_requestor_id_fkey" FOREIGN KEY ("requestor_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_truck_plate_fkey" FOREIGN KEY ("truck_plate") REFERENCES "Truck"("plate") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_route_type_id_fkey" FOREIGN KEY ("route_type_id") REFERENCES "RouteType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripStop" ADD CONSTRAINT "TripStop_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "Trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripStop" ADD CONSTRAINT "TripStop_consignee_id_fkey" FOREIGN KEY ("consignee_id") REFERENCES "Consignee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Consignee" ADD CONSTRAINT "Consignee_zone_code_fkey" FOREIGN KEY ("zone_code") REFERENCES "Zone"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Consignee" ADD CONSTRAINT "Consignee_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CargoDetail" ADD CONSTRAINT "CargoDetail_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "Trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripDocument" ADD CONSTRAINT "TripDocument_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "Trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationLog" ADD CONSTRAINT "LocationLog_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "Trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationLog" ADD CONSTRAINT "LocationLog_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleMaintenance" ADD CONSTRAINT "VehicleMaintenance_truck_plate_fkey" FOREIGN KEY ("truck_plate") REFERENCES "Truck"("plate") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalForwarder" ADD CONSTRAINT "ExternalForwarder_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "Trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FuelLog" ADD CONSTRAINT "FuelLog_truck_plate_fkey" FOREIGN KEY ("truck_plate") REFERENCES "Truck"("plate") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FuelLog" ADD CONSTRAINT "FuelLog_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ZoneAdjacency" ADD CONSTRAINT "_ZoneAdjacency_A_fkey" FOREIGN KEY ("A") REFERENCES "Zone"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ZoneAdjacency" ADD CONSTRAINT "_ZoneAdjacency_B_fkey" FOREIGN KEY ("B") REFERENCES "Zone"("code") ON DELETE CASCADE ON UPDATE CASCADE;
