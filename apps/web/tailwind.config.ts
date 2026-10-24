import type { Config } from "tailwindcss";

/**
 * Sweep Console v2.
 *
 * The look is vendored at src/styles/modernist.css (structure) overridden by
 * src/styles/sweep-v2.css (appearance); THAT pair is the source of truth. This
 * config only exposes it to Tailwind utilities: radii and shadows resolve to
 * its custom properties, and the `brand` scale mirrors its accent ramp so
 * utilities like `text-brand-600` and opacity modifiers (`bg-brand-600/10`)
 * keep working.
 *
 * The literal hexes below CANNOT be `var(--color-accent)`: Tailwind generates
 * opacity modifiers by slicing a colour channel, which it cannot do through a
 * custom property. So they are duplicated here and must be kept in step with
 * sweep-v2.css by hand — if you retune the accent, edit that file and mirror
 * it here.
 */
const config: Config = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Indigo #4447D6, the v2 accent. 6.73:1 on white — measured, AA at any
        // size — so unlike the 4.96:1 blue it replaces, the BASE step is safe
        // for body-size accent text, and 700/800 are hover and pressed rather
        // than the readable ones. Mirrors --color-accent-* in sweep-v2.css.
        brand: {
          50:  "#FAFAFE",
          100: "#F5F5FE",
          200: "#EEEEFC",
          300: "#DCDDFB",
          400: "#C9CAF6",
          500: "#8A8CE8",
          600: "#4447D6", // base accent — safe for accent text on white
          700: "#3639C4", // hover
          800: "#2F32B8", // pressed
          900: "#262995",
          950: "#1C1E6E",
        },
        // The v2 ground: white, with violet-tinted surfaces rather than the
        // warm greys the previous accent was tuned against.
        ground:  "#ffffff",
        surface: "#F4F4FB",
        ink:     "#23233B",
      },
      fontFamily: {
        sans: ["Plus Jakarta Sans", "system-ui", "sans-serif"],
        heading: ["Plus Jakarta Sans", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
      },
      // These resolve to the CSS variables, so they followed sweep-v2.css from
      // 0px to 7/9/14 without changing here. `none` stays a literal: a few
      // places want a square edge regardless of the system's radius.
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
