export default function Button({ children, onClick, className }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition ${className || ''}`}
    >
      {children}
    </button>
  );
}
