export default async function LeadsPage() {
  const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/leads`, {
    cache: "no-store",
  });
  const { leads } = await res.json();

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Leads</h1>

      {(!leads || leads.length === 0) && (
        <p className="text-gray-500">No leads found yet.</p>
      )}

      <div className="grid gap-3">
        {leads?.map((lead) => (
          <div
            key={lead.id}
            className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm"
          >
            <div className="flex justify-between items-center mb-2">
              <h2 className="font-semibold text-lg">
                {lead.phone ? `(${lead.phone})` : "Unknown Lead"}
              </h2>
              {lead.intent && (
                <span className="text-sm bg-blue-100 text-blue-700 px-2 py-1 rounded-full">
                  {lead.intent}
                </span>
              )}
            </div>
            <p className="text-gray-700">{lead.message}</p>
            {lead.property && (
              <p className="text-gray-500 text-sm mt-1">
                Property: {lead.property}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
