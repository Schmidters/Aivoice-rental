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
          setProperty({
            ...json.data.facts,
            slug: json.data.facts.slug,
            address: json.data.facts.address,
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
      });
    }
  }, [slugFromUrl]);

  // 🧩 Handle field changes, auto-generate slug from address
  const handleChange = (field, value) => {
    setProperty((prev) => {
      if (field === "address") {
        const autoSlug = slugify(value);
        return { ...prev, address: value, slug: autoSlug };
      }
      return { ...prev, [field]: value };
    });
  };

  // 🧩 Save handler — POST or PUT with correct shape
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
          notes: property.notes || null,
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

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `HTTP ${res.status}`);
      }

      const json = await res.json();
      if (json.ok) {
        toast.success(isNew ? "✅ Property created!" : "✅ Changes saved!");
        window.sessionStorage.setItem("savedFromEditor", "true");
        setTimeout(() => {
          window.location.href = "/properties";
        }, 800);
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
    <div className="p-6 space-y-6">
      <h1 className="text-xl font-semibold">
        {slugFromUrl ? "Edit Property" : "Add New Property"}
      </h1>

      <div className="grid grid-cols-2 gap-4 max-w-3xl">
        <div>
          <Label>Address</Label>
          <Input
            value={property.address || ""}
            onChange={(e) => handleChange("address", e.target.value)}
          />
        </div>
        <div>
          <Label>Rent</Label>
          <Input
            value={property.rent || ""}
            onChange={(e) => handleChange("rent", e.target.value)}
          />
        </div>
        <div>
          <Label>Bedrooms</Label>
          <Input
            value={property.bedrooms || ""}
            onChange={(e) => handleChange("bedrooms", e.target.value)}
          />
        </div>
        <div>
          <Label>Bathrooms</Label>
          <Input
            value={property.bathrooms || ""}
            onChange={(e) => handleChange("bathrooms", e.target.value)}
          />
        </div>
        <div>
          <Label>Sqft</Label>
          <Input
            value={property.sqft || ""}
            onChange={(e) => handleChange("sqft", e.target.value)}
          />
        </div>
        <div>
          <Label>Parking</Label>
          <Input
            value={property.parking || ""}
            onChange={(e) => handleChange("parking", e.target.value)}
          />
        </div>
        <div>
          <Label>Utilities</Label>
          <Input
            value={property.utilities || ""}
            onChange={(e) => handleChange("utilities", e.target.value)}
          />
        </div>
        <div>
          <Label>Availability</Label>
          <Input
            value={property.availability || ""}
            onChange={(e) => handleChange("availability", e.target.value)}
          />
        </div>

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

        <div className="col-span-2">
          <Label>Notes</Label>
          <Textarea
            value={property.notes || ""}
            onChange={(e) => handleChange("notes", e.target.value)}
            rows={3}
          />
        </div>
      </div>

      <Button onClick={handleSave} disabled={saving}>
        {saving ? "Saving…" : "Save Changes"}
      </Button>
    </div>
  );
}
