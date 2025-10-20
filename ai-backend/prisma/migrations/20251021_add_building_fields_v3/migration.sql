-- Migration: add_building_fields (Ava V7, aligned with backend)
-- Purpose: Expand PropertyFacts to support all Ava V7 manual fields

------------------------------------------------------------
-- Drop deprecated columns (safe even if not present)
------------------------------------------------------------
ALTER TABLE "PropertyFacts"
DROP COLUMN IF EXISTS "summary",
DROP COLUMN IF EXISTS "rawJson";

------------------------------------------------------------
-- Ensure all Ava V7 fields exist
------------------------------------------------------------
ALTER TABLE "PropertyFacts"
ADD COLUMN IF NOT EXISTS "unitType"            TEXT,
ADD COLUMN IF NOT EXISTS "buildingName"        TEXT,
ADD COLUMN IF NOT EXISTS "leaseType"           TEXT,
ADD COLUMN IF NOT EXISTS "leaseTerm"           TEXT,
ADD COLUMN IF NOT EXISTS "deposit"             TEXT,
ADD COLUMN IF NOT EXISTS "rent"                TEXT,
ADD COLUMN IF NOT EXISTS "bedrooms"            TEXT,
ADD COLUMN IF NOT EXISTS "bathrooms"           TEXT,
ADD COLUMN IF NOT EXISTS "sqft"                TEXT,
ADD COLUMN IF NOT EXISTS "availability"        TEXT,
ADD COLUMN IF NOT EXISTS "furnished"           BOOLEAN,
ADD COLUMN IF NOT EXISTS "petsAllowed"         BOOLEAN,
ADD COLUMN IF NOT EXISTS "petPolicy"           TEXT,
ADD COLUMN IF NOT EXISTS "parking"             TEXT,
ADD COLUMN IF NOT EXISTS "parkingOptions"      TEXT,
ADD COLUMN IF NOT EXISTS "utilities"           TEXT,
ADD COLUMN IF NOT EXISTS "includedUtilities"   TEXT,
ADD COLUMN IF NOT EXISTS "amenities"           JSONB,
ADD COLUMN IF NOT EXISTS "notes"               TEXT,
ADD COLUMN IF NOT EXISTS "listingUrl"          TEXT,
ADD COLUMN IF NOT EXISTS "managedBy"           TEXT,
ADD COLUMN IF NOT EXISTS "floorPlans"          JSONB,
ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP DEFAULT NOW(),
ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP DEFAULT NOW();

------------------------------------------------------------
-- Rename legacy column if it exists
------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'PropertyFacts' AND column_name = 'utilitiesIncluded'
  ) THEN
    ALTER TABLE "PropertyFacts" RENAME COLUMN "utilitiesIncluded" TO "includedUtilities";
  END IF;
END $$;
