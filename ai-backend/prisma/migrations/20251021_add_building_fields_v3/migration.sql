-- Migration: add_building_fields_and_scheduling (Ava V8)
-- Purpose: Expand PropertyFacts + introduce Booking scheduling + Availability support
-- Safe for repeated runs (uses IF NOT EXISTS)

------------------------------------------------------------
-- 🏢 PROPERTY FACTS (Ava V7 compatibility)
------------------------------------------------------------
ALTER TABLE "PropertyFacts"
DROP COLUMN IF EXISTS "summary",
DROP COLUMN IF EXISTS "rawJson";

ALTER TABLE "PropertyFacts"
ADD COLUMN IF NOT EXISTS "unitType"            TEXT,
ADD COLUMN IF NOT EXISTS "buildingName"        TEXT,
ADD COLUMN IF NOT EXISTS "buildingType"        TEXT,
ADD COLUMN IF NOT EXISTS "leaseType"           TEXT,
ADD COLUMN IF NOT EXISTS "leaseTerm"           TEXT,
ADD COLUMN IF NOT EXISTS "deposit"             TEXT,
ADD COLUMN IF NOT EXISTS "rent"                TEXT,
ADD COLUMN IF NOT EXISTS "description"         TEXT,
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
ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP DEFAULT NOW(),
ADD COLUMN IF NOT EXISTS "units" JSONB;

------------------------------------------------------------
-- 🗓️ BOOKING (Scheduling upgrades)
------------------------------------------------------------
-- Add scheduling-related columns if missing
ALTER TABLE "Booking"
ADD COLUMN IF NOT EXISTS "duration"  INTEGER DEFAULT 30,   -- minutes
ADD COLUMN IF NOT EXISTS "status"    TEXT DEFAULT 'pending',  -- pending|confirmed|cancelled
ADD COLUMN IF NOT EXISTS "notes"     TEXT;

-- Ensure "source" column exists for origin tracking (sms/dashboard)
ALTER TABLE "Booking"
ADD COLUMN IF NOT EXISTS "source"    TEXT;

------------------------------------------------------------
-- 🕒 AVAILABILITY (New table)
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "Availability" (
  "id"           SERIAL PRIMARY KEY,
  "propertyId"   INTEGER NOT NULL REFERENCES "Property"("id") ON DELETE CASCADE,
  "startTime"    TIMESTAMP NOT NULL,
  "endTime"      TIMESTAMP NOT NULL,
  "isBlocked"    BOOLEAN DEFAULT FALSE,
  "notes"        TEXT,
  "createdAt"    TIMESTAMP DEFAULT NOW()
);

------------------------------------------------------------
-- ⏱️ Ensure all showings default to 30 minutes
------------------------------------------------------------
ALTER TABLE "Booking"
ALTER COLUMN "duration" SET DEFAULT 30;

------------------------------------------------------------
-- ✅ END
------------------------------------------------------------
