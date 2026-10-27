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
        /**
         * Tailwind's default grey, replaced with the token ramp.
         *
         * The payer screens — authorize, payment link, the gateway panel —
         * style text with `text-gray-*`, which reads from here and never
         * touches --color-neutral-*. So the ramp that was tuned for contrast
         * applied to the console and stopped at the checkout, and the two
         * drifted apart without either looking wrong on its own.
         *
         * Measured against the three grounds these actually sit on (white,
         * the #F4F4FB surface tint, and #FAFAFC):
         *
         *   gray-500 #6b7280   4.83 / 4.42 / 4.64   FAILED AA on the tint
         *   gray-600 #4b5563   7.56 / 6.90 / 7.25   passed, still thin
         *
         * Mapped onto the neutral ramp, 500 and 600 now land at 8.50/7.76 and
         * 10.26/9.37. The light steps keep roughly their old lightness, so a
         * border or a fill written as gray-200 does not turn into a slab.
         */
        gray: {
          50:  "#FAFAFC",
          100: "#F4F4FB",
          200: "#ECECF3",
          300: "#E2E2EC",
          400: "#D4D5E2",
          500: "#4A4B61", // was #6b7280 — body-size secondary text
          600: "#3E3F55", // was #4b5563
          700: "#2C2C47",
          800: "#23233B",
          900: "#1A1A2B",
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
