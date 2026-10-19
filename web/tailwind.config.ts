import type { Config } from "tailwindcss";

export default {
  content: [
    "./app/**/*.{ts,tsx}",
    "./src/**/*.{ts,tsx}",
    "./public/**/*.{html,js}",
    "../packages/pulp/src/**/*.{ts,tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-geist-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "ui-monospace", "monospace"],
      },
      colors: {
        accent: {
          50: "#fffbef", 100: "#fcf0cc", 200: "#f6dd94", 300: "#f1ca6c",
          400: "#edbb50", 500: "#e8ad39", 600: "#cf942a", 700: "#895809",
          800: "#65420e", 900: "#49320f", 950: "#291d0b",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
