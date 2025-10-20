-- Migration: add_building_fields (Ava V7)
-- Purpose: Expand PropertyFacts to support multiple unit types, floorplans, and amenities.
-- Compatible with PostgreSQL.

------------------------------------------------------------
-- Clean-up (optional): remove deprecated columns if present
------------------------------------------------------------
ALTER TABLE "PropertyFacts"
DROP COLUMN IF EXISTS "summary",
DROP COLUMN IF EXISTS "rawJson";

------------------------------------------------------------
-- Core property metadata
------------------------------------------------------------
ALTER TABLE "PropertyFacts"
ADD COLUMN IF NOT EXISTS "buildingName"        TEXT,       -- e.g. “Junction 88”
ADD COLUMN IF NOT EXISTS "unitType"            TEXT,       -- e.g. “1 Bed 1 Bath”, “2 Bed + Den”
ADD COLUMN IF NOT EXISTS "address"             TEXT,
ADD COLUMN IF NOT EXISTS "rent"                TEXT,
ADD COLUMN IF NOT EXISTS "deposit"             TEXT,
ADD COLUMN IF NOT EXISTS "leaseTerm"           TEXT,
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
ADD COLUMN IF NOT EXISTS "notes"               TEXT;

------------------------------------------------------------
-- Structured JSON fields (for richer UI integration)
------------------------------------------------------------
ALTER TABLE "PropertyFacts"
ADD COLUMN IF NOT EXISTS "floorPlans" JSONB,   -- [{ name, rent, sqft, bedrooms, bathrooms }]
ADD COLUMN IF NOT EXISTS "amenities"  JSONB;   -- [{ category, items: [...] }]

------------------------------------------------------------
-- Listing / management metadata
------------------------------------------------------------
ALTER TABLE "PropertyFacts"
ADD COLUMN IF NOT EXISTS "managedBy"  TEXT,    -- e.g. “Mainstreet Equities”
ADD COLUMN IF NOT EXISTS "listingUrl" TEXT;    -- canonical external listing link

------------------------------------------------------------
-- Timestamp safety
------------------------------------------------------------
ALTER TABLE "PropertyFacts"
ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP DEFAULT NOW(),
ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP DEFAULT NOW();
