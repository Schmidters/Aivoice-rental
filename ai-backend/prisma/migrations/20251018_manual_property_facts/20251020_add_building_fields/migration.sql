-- Migration: add_building_fields (Ava V7)
-- Purpose: Add advanced property info fields

ALTER TABLE "PropertyFacts"
ADD COLUMN IF NOT EXISTS "buildingName" TEXT,
ADD COLUMN IF NOT EXISTS "unitType" TEXT,
ADD COLUMN IF NOT EXISTS "deposit" TEXT,
ADD COLUMN IF NOT EXISTS "leaseTerm" TEXT,
ADD COLUMN IF NOT EXISTS "includedUtilities" TEXT,
ADD COLUMN IF NOT EXISTS "floorPlans" JSONB,
ADD COLUMN IF NOT EXISTS "amenities" JSONB,
ADD COLUMN IF NOT EXISTS "petPolicy" TEXT,
ADD COLUMN IF NOT EXISTS "parkingOptions" TEXT,
ADD COLUMN IF NOT EXISTS "managedBy" TEXT,
ADD COLUMN IF NOT EXISTS "listingUrl" TEXT;
