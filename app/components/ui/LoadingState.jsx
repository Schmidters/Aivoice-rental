export default function LoadingState({ label = "Loading..." }) {
  return (
    <div className="flex h-[60vh] items-center justify-center text-gray-500">
      <div className="flex items-center gap-2">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-transparent" />
        <span>{label}</span>
      </div>
    </div>
  );
}
