// ai-backend/routes/properties.js
import express from "express";

export default function makePropertiesRouter(prisma) {
  const router = express.Router();

  // GET /api/properties → list all facts (latest first)
  router.get("/", async (req, res) => {
    try {
      const properties = await prisma.propertyFacts.findMany({
        orderBy: { updatedAt: "desc" },
      });
      res.json({ ok: true, data: properties });
    } catch (err) {
      console.error("GET /api/properties failed:", err);
      res.status(500).json({ ok: false, error: "SERVER_ERROR" });
    }
  });

  // GET /api/properties/:slug → single property
  router.get("/:slug", async (req, res) => {
    try {
      const { slug } = req.params;
      const property = await prisma.propertyFacts.findUnique({ where: { slug } });
      if (!property) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
      res.json({ ok: true, data: property });
    } catch (err) {
      console.error("GET /api/properties/:slug failed:", err);
      res.status(500).json({ ok: false, error: "SERVER_ERROR" });
    }
  });

  return router;
}
