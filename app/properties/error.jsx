"use client";

export default function Error({ error, reset }) {
  console.error("❌ Page crashed:", error);
  return (
    <div className="p-6 text-red-600">
      <h2 className="font-semibold text-lg mb-2">Something went wrong</h2>
      <p className="text-sm text-gray-700 mb-4">{error?.message || "Unknown error"}</p>
      <button
        onClick={() => reset()}
        className="px-4 py-2 rounded-md bg-blue-600 text-white"
      >
        Try again
      </button>
    </div>
  );
}
