// app/api/conversations/[id]/route.js
export async function GET(request, context) {
  const id = decodeURIComponent(context.params.id);
  const aiBackendBase = process.env.NEXT_PUBLIC_AI_BACKEND_URL;
  const url = `${aiBackendBase}/history/${encodeURIComponent(id)}`;

  try {
    console.log("➡️ Fetching history from backend:", url);
    const r = await fetch(url, { cache: "no-store" });

    if (!r.ok) {
      throw new Error(`Backend returned ${r.status}`);
    }

    const j = await r.json();

    // 🧠 Normalize backend format → dashboard format
    const messages = (j.messages || []).map((m) => ({
      t: m.ts,
      role:
        m.sender === "lead"
          ? "user"
          : m.sender === "ai"
          ? "assistant"
          : "agent",
      content: m.text,
      meta: m.meta,
    }));

    const payload = {
      ok: true,
      id,
      lead: j.phone || id,
      mode: j.mode || "auto",
      handoffReason: j.handoffReason || "",
      owner: j.owner || "",
      messages,
      properties: [],
    };

    console.log(`✅ Normalized ${messages.length} messages`);
    return new Response(JSON.stringify(payload), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  } catch (err) {
    console.error("❌ Error fetching history:", err);
    return new Response(
      JSON.stringify({ ok: false, error: err.message }),
      {
        headers: { "Content-Type": "application/json" },
        status: 500,
      }
    );
  }
}
