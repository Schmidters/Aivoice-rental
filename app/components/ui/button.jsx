export default function Button({ children, ...props }) {
  return <button {...props} className='rounded-lg bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 text-sm transition'>{children}</button>;
}
