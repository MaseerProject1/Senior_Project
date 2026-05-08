/** @type {import("tailwindcss").Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx,ts,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        maseer: {
          dark: "#002B24",
          green: "#003D34",
          teal: "#00856F",
          mint: "#BFEFE3",
          bg: "#F7FAF8"
        }
      }
    },
  },
  plugins: [],
}