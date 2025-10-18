import express from "express";
import { PrismaClient } from "@prisma/client";

const router = express.Router();
const prisma = new PrismaClient();

// ✅ Get all properties
router.get("/", async (req, res) => {
  try {
    const data = await prisma.propertyFacts.findMany({
      orderBy: { updatedAt: "desc" },
    });
    res.json({ ok: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Failed to fetch properties" });
  }
});

// ✅ Get one property by slug
router.get("/:slug", async (req, res) => {
  try {
    const data = await prisma.propertyFacts.findUnique({
      where: { slug: req.params.slug },
    });
    if (!data) return res.json({ ok: false, error: "Not found" });
    res.json({ ok: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Failed to fetch property" });
  }
});

// ✅ Create new property
router.post("/", async (req, res) => {
  try {
    const data = await prisma.propertyFacts.create({
      data: {
        slug: req.body.slug || `property-${Date.now()}`,
        address: req.body.address || null,
        rent: req.body.rent || null,
        bedrooms: req.body.bedrooms || null,
        bathrooms: req.body.bathrooms || null,
        sqft: req.body.sqft || null,
        parking: req.body.parking || null,
        utilities: req.body.utilities || null,
        availability: req.body.availability || null,
        petsAllowed: req.body.petsAllowed || false,
        furnished: req.body.furnished || false,
        notes: req.body.notes || null,
      },
    });
    res.json({ ok: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Failed to create property" });
  }
});

// ✅ Update property by slug
router.put("/:slug", async (req, res) => {
  try {
    const updated = await prisma.propertyFacts.update({
      where: { slug: req.params.slug },
      data: req.body,
    });
    res.json({ ok: true, data: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Failed to update property" });
  }
});

export default router;
