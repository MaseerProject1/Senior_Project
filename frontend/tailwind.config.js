/** @type {import("tailwindcss").Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        maseer: {
          dark: "#002B24",
          green: "#003D34",
          teal: "#00856F",
          mint: "#DDF7EF",
          bg: "#F7FAF8",
        },
        brand: {
          bg: "#F7FAF8",
          border: "#E3EEE9",
          text: "#10201B",
          muted: "#66736D",
          primary: "#008B78",
          secondary: "#008B78",
          deep: "#003C35",
          mid: "#004940",
          mint: "#DDF7EF",
          teal: "#00856F",
          warning: "#F7B731",
          critical: "#B42318",
        },
      },
      boxShadow: {
        card: "0 1px 3px rgb(16 32 27 / 0.06), 0 10px 24px rgb(16 32 27 / 0.04)",
        soft: "0 12px 40px rgb(0 43 36 / 0.08)",
      },
    },
  },
  plugins: [],
};
