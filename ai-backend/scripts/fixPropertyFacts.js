// scripts/fixPropertyFacts.js
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  console.log("🔧 Fixing PropertyFacts propertyId links...");

  const facts = await prisma.propertyFacts.findMany({
    where: { propertyId: null },
  });

  if (facts.length === 0) {
    console.log("✅ All PropertyFacts are already linked.");
    return;
  }

  for (const f of facts) {
    const prop = await prisma.property.findUnique({
      where: { slug: f.slug },
    });
    if (prop) {
      await prisma.propertyFacts.update({
        where: { id: f.id },
        data: { propertyId: prop.id },
      });
      console.log(`✅ Linked ${f.slug} → propertyId ${prop.id}`);
    } else {
      console.warn(`⚠️ No Property found for slug '${f.slug}'`);
    }
  }

  console.log("✅ Done. All orphaned PropertyFacts are linked.");
}

main()
  .catch((e) => {
    console.error("❌ Error:", e);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
