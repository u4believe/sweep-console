import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  "#eef2ff",
          100: "#e1e7ff",
          200: "#c8d2ff",
          300: "#a6b5ff",
          400: "#8194ff",
          500: "#6075fb",
          600: "#3a4ef6", // lightened brand blue (logo itself stays #1128F5)
          700: "#2c3ad8",
          800: "#2731ac",
          900: "#252f86",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
