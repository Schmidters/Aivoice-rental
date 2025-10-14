export async function POST(req, { params }) {
  const id = decodeURIComponent(params.id);
  const aiBackendBase = process.env.NEXT_PUBLIC_AI_BACKEND_URL;
  const { text } = await req.json();

  const url = `${aiBackendBase}/send/${encodeURIComponent(id)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  const j = await r.json().catch(() => ({}));
  return Response.json(j);
}
