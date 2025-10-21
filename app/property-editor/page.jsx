"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import Button from "@/components/ui/button";
import { toast } from "sonner";

const BACKEND = process.env.NEXT_PUBLIC_AI_BACKEND_URL;

// 🧩 Helper to generate slugs from address
function slugify(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

export default function PropertyEditorPage() {
  return (
    <Suspense fallback={<div className="p-6 text-gray-500">Loading editor…</div>}>
      <PropertyEditorContent />
    </Suspense>
  );
}

function PropertyEditorContent() {
  const searchParams = useSearchParams();
  const slugFromUrl = searchParams.get("slug");
  const [property, setProperty] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);


  // 🧩 Load property if slug provided
  useEffect(() => {
    if (!slugFromUrl) return;
    const loadProperty = async () => {
      setLoading(true);
      try {
        const res = await fetch(`${BACKEND}/api/property-editor/${slugFromUrl}`);
        const json = await res.json();
        if (json.ok) {
          const facts = json.data.facts || {};
          setProperty({
            slug: json.data.slug,
            address: facts.address || json.data.address || "",
            rent: facts.rent || "",
            bedrooms: facts.bedrooms || "",
            bathrooms: facts.bathrooms || "",
            sqft: facts.sqft || "",
            parking: facts.parking || "",
            utilities: facts.utilities || "",
            availability: facts.availability || "",
            petsAllowed: facts.petsAllowed ?? false,
            furnished: facts.furnished ?? false,
            notes: facts.notes || "",
            // New fields
            buildingName: facts.buildingName || "",
            buildingType: facts.buildingType || "",
            description: facts.description || "",
            leaseType: facts.leaseType || "",
            deposit: facts.deposit || "",
            managedBy: facts.managedBy || "",
            listingUrl: facts.listingUrl || "",
            utilitiesIncluded: facts.utilitiesIncluded || "",
            petPolicy: facts.petPolicy || "",
            parkingOptions: facts.parkingOptions || "",
            amenities: facts.amenities || "",
            units: facts.units || [], 
          });
        } else {
          toast.error("Property not found");
        }
      } catch (err) {
        console.error("Error loading property:", err);
        toast.error("Failed to load property");
      } finally {
        setLoading(false);
      }
    };
    loadProperty();
  }, [slugFromUrl]);

  // 🧩 Create blank new property if no slug
  useEffect(() => {
    if (!slugFromUrl) {
      setProperty({
        slug: "",
        address: "",
        rent: "",
        bedrooms: "",
        bathrooms: "",
        sqft: "",
        parking: "",
        utilities: "",
        availability: "",
        petsAllowed: false,
        furnished: false,
        notes: "",
        // new fields
        buildingName: "",
        buildingType: "",
        description: "",
        leaseType: "",
        deposit: "",
        managedBy: "",
        listingUrl: "",
        utilitiesIncluded: "",
        petPolicy: "",
        parkingOptions: "",
        amenities: "",
        units: [],
      });
    }
  }, [slugFromUrl]);

  // 🧩 Handle field changes
  const handleChange = (field, value) => {
    setProperty((prev) => {
      if (field === "address") {
        const autoSlug = slugify(value);
        return { ...prev, address: value, slug: autoSlug };
      }
      return { ...prev, [field]: value };
    });
  };

  // 🧩 Save handler (fixed)
const handleSave = async () => {
  if (!property) return;
  setSaving(true);
  try {
    const isNew = !slugFromUrl;

    const payload = {
      slug: property.slug || slugify(property.address),
      address: property.address || null,
      facts: {
        rent: property.rent || null,
        bedrooms: property.bedrooms || null,
        bathrooms: property.bathrooms || null,
        sqft: property.sqft || null,
        parking: property.parking || null,
        utilities: property.utilities || null,
        petsAllowed: property.petsAllowed ?? null,
        furnished: property.furnished ?? null,
        availability: property.availability || null,
        notes: property.notes || null, // ✅ fixed field names
        buildingName: property.buildingName || null,
        buildingType: property.buildingType || null,
        description: property.description || null,
        leaseType: property.leaseType || null,
        deposit: property.deposit || null,
        managedBy: property.managedBy || null,
        listingUrl: property.listingUrl || null,
        includedUtilities: property.utilitiesIncluded || null, // 🔥 correct field name
        petPolicy: property.petPolicy || null,
        parkingOptions: property.parkingOptions || null,
        amenities: property.amenities || null,
        units: property.units || [], // 🧩 new multi-unit data
      },
    };

    const url = isNew
      ? `${BACKEND}/api/property-editor`
      : `${BACKEND}/api/property-editor/${payload.slug}`;

    const res = await fetch(url, {
      method: isNew ? "POST" : "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const json = await res.json();

    if (json.ok) {
      toast.success(isNew ? "✅ Property created!" : "✅ Changes saved!");

      // 🔔 Notify Property Data page to refresh
  window.dispatchEvent(new Event("propertyDataUpdated"));

    // ✅ Mark for refresh when user navigates back
  sessionStorage.setItem("propertyDataNeedsRefresh", "true");


      // 🩹 1️⃣ Re-fetch updated property facts (fresh from backend)
      const updatedFacts = await fetch(`${BACKEND}/api/property-editor/${payload.slug}`)
        .then((res) => res.json())
        .then((data) => data?.data?.facts || {});

      // 🩹 2️⃣ Update the local property state with fresh data
      setProperty((prev) => ({
        ...prev,
        ...updatedFacts,
        updatedAt: new Date().toISOString(),
      }));

      // 🩹 3️⃣ Refresh the global property list (Property Data tab)
      const all = await fetch(`${BACKEND}/api/property-editor`)
        .then((res) => res.json())
        .then((data) => data?.data || []);
      if (typeof setAllProperties === "function") setAllProperties(all);

      console.log("✅ Property and full list reloaded after save");
      // 🔔 Notify other tabs (like Property Data) that data changed
window.dispatchEvent(new Event("propertyDataUpdated"));

    } else {
      toast.error(json.error || "Save failed");
    }
  } catch (err) {
    console.error("Save error:", err);
    toast.error(`Save failed: ${err.message || "Unknown error"}`);
  } finally {
    setSaving(false);
  }
};


  if (loading)
    return <div className="p-6 text-sm text-gray-500">Loading property…</div>;

  if (!property)
    return (
      <div className="p-6 text-sm text-gray-500">
        No property selected. Go back to{" "}
        <Link href="/properties" className="text-blue-600 underline">
          Property Data
        </Link>
        .
      </div>
    );

 
return (
  <div className="p-6 space-y-8">
    <h1 className="text-2xl font-semibold text-gray-800">
      {slugFromUrl ? "Edit Property" : "Add New Property"}
    </h1>

    {property?.updatedAt && (
      <div className="text-sm text-green-600">
        ✅ Saved {new Date(property.updatedAt).toLocaleTimeString()}
      </div>
    )}

    {/* 🏢 BUILDING INFO */}
    <section className="border border-gray-200 rounded-xl p-5 bg-white shadow-sm">
      <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
        🏢 Building Info
      </h2>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>Building Name</Label>
          <Input
            value={property.buildingName || ""}
            onChange={(e) => handleChange("buildingName", e.target.value)}
          />
        </div>
        <div>
          <Label>Building Type</Label>
          <Input
            value={property.buildingType || ""}
            onChange={(e) => handleChange("buildingType", e.target.value)}
          />
        </div>
        <div className="col-span-2">
          <Label>Description</Label>
          <Textarea
            value={property.description || ""}
            onChange={(e) => handleChange("description", e.target.value)}
            rows={3}
          />
        </div>
      </div>
    </section>

    {/* 📍 CORE INFO */}
    <section className="border border-gray-200 rounded-xl p-5 bg-white shadow-sm">
      <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
        📍 Core Info
      </h2>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>Address</Label>
          <Input
            value={property.address || ""}
            onChange={(e) => handleChange("address", e.target.value)}
          />
        </div>
    
        <div>
          <Label>Lease Type</Label>
          <Input
            value={property.leaseType || ""}
            onChange={(e) => handleChange("leaseType", e.target.value)}
          />
        </div>
        <div>
          <Label>Managed By</Label>
          <Input
            value={property.managedBy || ""}
            onChange={(e) => handleChange("managedBy", e.target.value)}
          />
        </div>
        <div className="col-span-2">
          <Label>Listing URL</Label>
          <Input
            value={property.listingUrl || ""}
            onChange={(e) => handleChange("listingUrl", e.target.value)}
          />
        </div>
      </div>
    </section>

    {/* 🏘️ UNIT TYPES */}
    <section className="border border-gray-200 rounded-xl p-5 bg-white shadow-sm">
      <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
        🏘️ Unit Types
      </h2>

      {Array.isArray(property.units) && property.units.length > 0 ? (
        property.units.map((unit, i) => (
          <div
            key={i}
            className="border rounded-lg p-4 mb-4 bg-gray-50 shadow-inner"
          >
            <div className="flex justify-between items-center mb-2">
              <h3 className="font-medium text-gray-700">
                Unit {i + 1} — {unit.unitType || "Untitled"}
              </h3>
              <button
                type="button"
                onClick={() =>
                  handleChange(
                    "units",
                    property.units.filter((_, j) => j !== i)
                  )
                }
                className="text-red-500 text-sm hover:underline"
              >
                Remove
              </button>
            </div>

            <div className="grid grid-cols-4 gap-3">
              <div>
                <Label>Unit Type</Label>
                <Input
                  value={unit.unitType || ""}
                  onChange={(e) =>
                    handleChange(
                      "units",
                      property.units.map((u, j) =>
                        j === i ? { ...u, unitType: e.target.value } : u
                      )
                    )
                  }
                />
              </div>
              <div>
                <Label>Bedrooms</Label>
                <Input
                  value={unit.bedrooms || ""}
                  onChange={(e) =>
                    handleChange(
                      "units",
                      property.units.map((u, j) =>
                        j === i ? { ...u, bedrooms: e.target.value } : u
                      )
                    )
                  }
                />
              </div>
              <div>
                <Label>Bathrooms</Label>
                <Input
                  value={unit.bathrooms || ""}
                  onChange={(e) =>
                    handleChange(
                      "units",
                      property.units.map((u, j) =>
                        j === i ? { ...u, bathrooms: e.target.value } : u
                      )
                    )
                  }
                />
              </div>
              <div>
                <Label>Rent</Label>
                <Input
                  value={unit.rent || ""}
                  onChange={(e) =>
                    handleChange(
                      "units",
                      property.units.map((u, j) =>
                        j === i ? { ...u, rent: e.target.value } : u
                      )
                    )
                  }
                />
              </div>
            </div>

            <div className="grid grid-cols-4 gap-3 mt-3">
              <div>
                <Label>Sqft</Label>
                <Input
                  value={unit.sqft || ""}
                  onChange={(e) =>
                    handleChange(
                      "units",
                      property.units.map((u, j) =>
                        j === i ? { ...u, sqft: e.target.value } : u
                      )
                    )
                  }
                />
              </div>
              <div>
                <Label>Deposit</Label>
                <Input
                  value={unit.deposit || ""}
                  onChange={(e) =>
                    handleChange(
                      "units",
                      property.units.map((u, j) =>
                        j === i ? { ...u, deposit: e.target.value } : u
                      )
                    )
                  }
                />
              </div>
              <div>
                <Label>Availability</Label>
                <Input
                  value={unit.availability || ""}
                  onChange={(e) =>
                    handleChange(
                      "units",
                      property.units.map((u, j) =>
                        j === i ? { ...u, availability: e.target.value } : u
                      )
                    )
                  }
                />
              </div>
              <div>
                <Label>Notes</Label>
                <Input
                  value={unit.notes || ""}
                  onChange={(e) =>
                    handleChange(
                      "units",
                      property.units.map((u, j) =>
                        j === i ? { ...u, notes: e.target.value } : u
                      )
                    )
                  }
                />
              </div>
            </div>
          </div>
        ))
      ) : (
        <div className="text-gray-500 text-sm mb-3">
          No unit types added yet.
        </div>
      )}

      <button
        type="button"
        onClick={() =>
          handleChange("units", [
            ...(property.units || []),
            {
              unitType: "",
              bedrooms: "",
              bathrooms: "",
              rent: "",
              sqft: "",
              deposit: "",
              availability: "",
              notes: "",
            },
          ])
        }
        className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm hover:bg-blue-700"
      >
        + Add Another Unit
      </button>
    </section>

    {/* ⚙️ PROPERTY-WIDE INFO */}
    <section className="border border-gray-200 rounded-xl p-5 bg-white shadow-sm">
      <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
        ⚙️ Property-wide Info
      </h2>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>Utilities Included</Label>
          <Input
            value={property.utilitiesIncluded || ""}
            onChange={(e) => handleChange("utilitiesIncluded", e.target.value)}
          />
        </div>
        <div>
          <Label>Pet Policy</Label>
          <Input
            value={property.petPolicy || ""}
            onChange={(e) => handleChange("petPolicy", e.target.value)}
          />
        </div>
        <div>
          <Label>Parking Options</Label>
          <Input
            value={property.parkingOptions || ""}
            onChange={(e) => handleChange("parkingOptions", e.target.value)}
          />
        </div>
        <div>
          <Label>Amenities</Label>
          <Input
            value={property.amenities || ""}
            onChange={(e) => handleChange("amenities", e.target.value)}
          />
        </div>
      </div>
    </section>

    {/* 🐾 TOGGLES + NOTES */}
    <section className="border border-gray-200 rounded-xl p-5 bg-white shadow-sm">
      <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
        🐾 Additional Details
      </h2>
      <div className="flex items-center gap-4 mb-3">
        <div className="flex items-center gap-2">
          <Switch
            checked={property.petsAllowed || false}
            onCheckedChange={(v) => handleChange("petsAllowed", v)}
          />
          <Label>Pets Allowed</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={property.furnished || false}
            onCheckedChange={(v) => handleChange("furnished", v)}
          />
          <Label>Furnished</Label>
        </div>
      </div>

      <Label>Notes</Label>
      <Textarea
        value={property.notes || ""}
        onChange={(e) => handleChange("notes", e.target.value)}
        rows={3}
      />
    </section>

    <div className="pt-4">
      <Button onClick={handleSave} disabled={saving} className="px-6 py-3 text-base">
        {saving ? "Saving…" : "💾 Save Changes"}
      </Button>
    </div>
  </div>
);
}