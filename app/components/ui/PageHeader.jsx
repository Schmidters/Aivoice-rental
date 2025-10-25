export default function PageHeader({ title, actions }) {
  return (
    <div className="mb-5 flex items-center justify-between border-b pb-2">
      <h1 className="text-2xl font-semibold">{title}</h1>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
