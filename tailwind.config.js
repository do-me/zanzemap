/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary: '#0c2461',
        secondary: '#1e3799',
        accent: '#00bfff',
        light: '#e3f2fd'
      }
    },
  },
  plugins: [],
}