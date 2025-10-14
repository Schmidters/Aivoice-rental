/** @type {import('tailwindcss').Config} */
module.exports = {
  // We control dark mode via the "dark" class (your ThemeToggle toggles it)
  darkMode: 'class',

  // Tell Tailwind where to scan for class names (JIT/purge).
  // Include every place we might use Tailwind classes.
  content: [
    './app/**/*.{js,jsx,ts,tsx}',
    './components/**/*.{js,jsx,ts,tsx}',
    './lib/**/*.{js,jsx,ts,tsx}',
    './pages/**/*.{js,jsx,ts,tsx}',   // safe even if we don't use /pages
    './**/*.mdx'                      // optional, if we ever add docs
  ],

  theme: {
    extend: {
      // add brand colors, spacing, etc. later as we lock design
    },
  },

  // Add plugins as we need them (forms/typography/line-clamp, etc.)
  plugins: [
    // require('@tailwindcss/forms'),
    // require('@tailwindcss/typography'),
    // require('@tailwindcss/line-clamp'),
  ],

  // Optional: if we ever dynamically generate class names, safelist them here
  // safelist: ['bg-red-500', 'text-green-600'],
};
