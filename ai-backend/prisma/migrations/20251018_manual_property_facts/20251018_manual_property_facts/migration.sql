-- Migration: manual_property_facts (Ava V7)
-- Purpose: Create base editable property fields

ALTER TABLE "PropertyFacts"
DROP COLUMN IF EXISTS "summary",
DROP COLUMN IF EXISTS "rawJson";

ALTER TABLE "PropertyFacts"
ADD COLUMN IF NOT EXISTS "address" TEXT,
ADD COLUMN IF NOT EXISTS "rent" TEXT,
ADD COLUMN IF NOT EXISTS "bedrooms" TEXT,
ADD COLUMN IF NOT EXISTS "bathrooms" TEXT,
ADD COLUMN IF NOT EXISTS "sqft" TEXT,
ADD COLUMN IF NOT EXISTS "parking" TEXT,
ADD COLUMN IF NOT EXISTS "utilities" TEXT,
ADD COLUMN IF NOT EXISTS "petsAllowed" BOOLEAN,
ADD COLUMN IF NOT EXISTS "furnished" BOOLEAN,
ADD COLUMN IF NOT EXISTS "availability" TEXT,
ADD COLUMN IF NOT EXISTS "notes" TEXT;
