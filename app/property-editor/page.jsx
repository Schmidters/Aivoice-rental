'use client';

import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

export default function PropertyEditorPage() {
  const [properties, setProperties] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load all properties on mount
  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const res = await fetch('/api/property-editor');
      const json = await res.json();
      setProperties(json.data || []);
      setLoading(false);
    };
    load();
  }, []);

  const handleSelect = (slug) => {
    const prop = properties.find((p) => p.slug === slug);
    setSelected(JSON.parse(JSON.stringify(prop))); // deep copy
  };

  const handleChange = (field, value) => {
    setSelected((prev) => ({
      ...prev,
      facts: { ...prev.facts, [field]: value },
    }));
  };

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    const res = await fetch(`/api/property-editor/${selected.slug}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ facts: selected.facts }),
    });
    const json = await res.json();
    setSaving(false);
    if (json.ok) {
      toast.success('Property updated!');
    } else {
      toast.error('Save failed');
    }
  };

  if (loading) return <div className="p-6">Loading properties...</div>;

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-xl font-semibold">Property Editor</h1>

      <div className="flex gap-4">
        {/* Sidebar list */}
        <div className="w-60 border-r pr-3 space-y-2">
          {properties.map((p) => (
            <Button
              key={p.slug}
              variant={selected?.slug === p.slug ? 'default' : 'outline'}
              className="w-full justify-start"
              onClick={() => handleSelect(p.slug)}
            >
              {p.address || p.slug}
            </Button>
          ))}
        </div>

        {/* Form */}
        {selected ? (
          <div className="flex-1 space-y-4">
            <h2 className="font-medium text-lg">{selected.slug}</h2>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Address</Label>
                <Input
                  value={selected.facts?.address || ''}
                  onChange={(e) => handleChange('address', e.target.value)}
                />
              </div>
              <div>
                <Label>Rent</Label>
                <Input
                  value={selected.facts?.rent || ''}
                  onChange={(e) => handleChange('rent', e.target.value)}
                />
              </div>
              <div>
                <Label>Bedrooms</Label>
                <Input
                  value={selected.facts?.bedrooms || ''}
                  onChange={(e) => handleChange('bedrooms', e.target.value)}
                />
              </div>
              <div>
                <Label>Bathrooms</Label>
                <Input
                  value={selected.facts?.bathrooms || ''}
                  onChange={(e) => handleChange('bathrooms', e.target.value)}
                />
              </div>
              <div>
                <Label>Sq ft</Label>
                <Input
                  value={selected.facts?.sqft || ''}
                  onChange={(e) => handleChange('sqft', e.target.value)}
                />
              </div>
              <div>
                <Label>Parking</Label>
                <Input
                  value={selected.facts?.parking || ''}
                  onChange={(e) => handleChange('parking', e.target.value)}
                />
              </div>
              <div>
                <Label>Utilities</Label>
                <Input
                  value={selected.facts?.utilities || ''}
                  onChange={(e) => handleChange('utilities', e.target.value)}
                />
              </div>
              <div>
                <Label>Availability</Label>
                <Input
                  value={selected.facts?.availability || ''}
                  onChange={(e) => handleChange('availability', e.target.value)}
                />
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={selected.facts?.petsAllowed || false}
                  onCheckedChange={(v) => handleChange('petsAllowed', v)}
                />
                <Label>Pets Allowed</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={selected.facts?.furnished || false}
                  onCheckedChange={(v) => handleChange('furnished', v)}
                />
                <Label>Furnished</Label>
              </div>
              <div className="col-span-2">
                <Label>Notes</Label>
                <Textarea
                  value={selected.facts?.notes || ''}
                  onChange={(e) => handleChange('notes', e.target.value)}
                  rows={3}
                />
              </div>
            </div>

            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save Changes'}
            </Button>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-500">
            Select a property to edit
          </div>
        )}
      </div>
    </div>
  );
}
