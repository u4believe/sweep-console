import type { Config } from "tailwindcss";

/**
 * Arc Blue — the "Modernist" design system.
 *
 * The design system itself is vendored at src/styles/modernist.css (+ the
 * arc-blue.css accent override); THAT is the source of truth. This config only
 * exposes it to Tailwind utilities: radii and shadows resolve to its custom
 * properties, and the `brand` scale mirrors its accent ramp so utilities like
 * `text-brand-600` and opacity modifiers (`bg-brand-600/10`) keep working.
 *
 * If you retune the accent, edit styles/arc-blue.css and mirror it here.
 * The system is square by design (--radius-* are 0px) — soften the whole app
 * by raising those variables rather than editing utilities page by page.
 */
const config: Config = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Arc docs blue. Arc's own #4d8ee9 only reaches 2.95:1 on this ground,
        // so the base step is the accessible #2f6fc9 (4.43:1) and #4d8ee9
        // lives on as step 500 for large text, fills, and decoration.
        brand: {
          50:  "#f7fafe",
          100: "#eff5fd",
          200: "#dbe9fa",
          300: "#bcd6f5",
          400: "#8ab8ee",
          500: "#4d8ee9",
          600: "#2f6fc9", // base accent — use this for accent text on light ground
          700: "#2359a6",
          800: "#1a4381",
          900: "#143160",
          950: "#12233f",
        },
        // The warm neutral ground the accent is tuned against.
        ground:  "#f3f2f2",
        surface: "#eae9e9",
        ink:     "#201e1d",
      },
      fontFamily: {
        sans: ["Archivo", "system-ui", "sans-serif"],
        heading: ["Archivo", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
      },
      borderRadius: {
        none: "0px",
        sm: "var(--radius-sm)",
        DEFAULT: "var(--radius-md)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-lg)",
        "2xl": "var(--radius-lg)",
        "3xl": "var(--radius-lg)",
        // Pills and avatars stay round on purpose.
        full: "9999px",
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        DEFAULT: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
      },
    },
  },
  plugins: [],
};

export default config;
