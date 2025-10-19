import express from "express";
import { PrismaClient } from "@prisma/client";

const router = express.Router();
const prisma = new PrismaClient();

// 🧩 GET all properties
router.get("/", async (req, res) => {
  try {
    const properties = await prisma.propertyFacts.findMany({
      orderBy: { updatedAt: "desc" },
    });

    res.json({
      ok: true,
      data: properties.map((p) => ({
        id: p.id,
        slug: p.slug,
        summary: p.notes || "",
        updatedAt: p.updatedAt,
        rawJson: p,
      })),
    });
  } catch (err) {
    console.error("❌ Error loading properties:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 🧩 GET one property by slug
router.get("/:slug", async (req, res) => {
  try {
    const property = await prisma.propertyFacts.findUnique({
      where: { slug: req.params.slug },
    });
    if (!property)
      return res.status(404).json({ ok: false, error: "Property not found" });

    res.json({ ok: true, data: property });
  } catch (err) {
    console.error("❌ Error fetching property:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 🧩 POST — create new property
router.post("/", async (req, res) => {
  try {
    const data = req.body;

    // 🧠 Auto-generate slug if not provided
    if (!data.slug) {
      if (data.address) {
        data.slug = data.address
          .toLowerCase()
          .replace(/[^\w\s-]/g, "")
          .trim()
          .replace(/\s+/g, "-");
      } else {
        return res
          .status(400)
          .json({ ok: false, error: "Address is required to create property" });
      }
    }

    // Ensure slug is unique
    const existing = await prisma.propertyFacts.findUnique({
      where: { slug: data.slug },
    });
    if (existing) {
      return res
        .status(400)
        .json({ ok: false, error: "Property slug already exists" });
    }

    const created = await prisma.propertyFacts.create({ data });
    console.log("💾 [Property Created]", created.slug);
    res.json({ ok: true, data: created });
  } catch (err) {
    console.error("❌ Error creating property:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});


// 🧩 PUT — update existing property
router.put("/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const data = req.body;

    // Make sure property exists
    const existing = await prisma.propertyFacts.findUnique({ where: { slug } });
    if (!existing) {
      return res.status(404).json({ ok: false, error: "Property not found" });
    }

    const updated = await prisma.propertyFacts.update({
      where: { slug },
      data,
    });

    // Re-fetch to return the freshest data (ensures updatedAt is current)
    const refreshed = await prisma.propertyFacts.findUnique({ where: { slug } });

    console.log("💾 [Property Updated]", slug);
    res.json({ ok: true, data: refreshed });
  } catch (err) {
    console.error("❌ Error updating property:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});


export default router;
