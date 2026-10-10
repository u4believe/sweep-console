import { defineConfig } from "vitepress";

/**
 * Sweep Console documentation.
 *
 * Deployed to docs.sweepconsole.xyz as its own Vercel project, with this
 * directory as the root. It shares a repository with the app but not a build:
 * a typo fix here does not rebuild the dashboard, and a dashboard deploy does
 * not touch the docs.
 *
 * The page it replaces rendered the platform fee from VITE_PLATFORM_FEE_BPS so
 * that changing the rate did not mean hunting literals through four files.
 * Static Markdown would lose that, so the rate is NOT written as a literal
 * anywhere in this site — <Fee /> reads it from the API at page load. See
 * .vitepress/theme/Fee.vue.
 */
export default defineConfig({
  title: "Sweep Console",
  description:
    "Take recurring USDC payments from a wallet — hosted plans with no billing code, or a rail you drive yourself.",
  lang: "en-GB",
  cleanUrls: true,
  lastUpdated: true,

  head: [
    ["link", { rel: "icon", href: "/favicon.svg" }],
    ["meta", { name: "theme-color", content: "#2f6fc9" }],
  ],

  themeConfig: {
    siteTitle: "Sweep Console",

    nav: [
      { text: "Hosted plans", link: "/hosted/overview", activeMatch: "/hosted/" },
      { text: "Payment rail", link: "/rail/quickstart", activeMatch: "/rail/" },
      { text: "Webhooks", link: "/webhooks/setup", activeMatch: "/webhooks/" },
      { text: "SDK", link: "/sdk/node", activeMatch: "/sdk/" },
      { text: "Dashboard", link: "https://www.sweepconsole.xyz/portal" },
    ],

    sidebar: [
      {
        text: "Start here",
        items: [
          { text: "Which one do I want?", link: "/" },
          { text: "Your account", link: "/hosted/account" },
        ],
      },
      {
        text: "Hosted plans",
        collapsed: false,
        items: [
          { text: "Overview", link: "/hosted/overview" },
          { text: "What a subscriber does", link: "/hosted/subscribing" },
          { text: "Wallets & email", link: "/hosted/wallets" },
          { text: "Upgrades & price changes", link: "/hosted/changes" },
          { text: "Revenue & settlement", link: "/hosted/revenue" },
          { text: "What subscribers run into", link: "/hosted/support" },
        ],
      },
      {
        text: "Payment rail",
        collapsed: false,
        items: [
          { text: "Quickstart", link: "/rail/quickstart" },
          { text: "What the rail is", link: "/rail/overview" },
          { text: "A working integration", link: "/rail/example" },
          { text: "Mandates", link: "/rail/mandates" },
          { text: "The authorization page", link: "/rail/authorize" },
          { text: "Charges", link: "/rail/charges" },
          { text: "Limits & refusals", link: "/rail/limits" },
          { text: "Idempotency", link: "/rail/idempotency" },
        ],
      },
      {
        text: "Webhooks",
        collapsed: false,
        items: [
          { text: "Set up an endpoint", link: "/webhooks/setup" },
          { text: "What your app must have", link: "/webhooks/your-code" },
          { text: "Events", link: "/webhooks/events" },
          { text: "Payload & headers", link: "/webhooks/payload" },
          { text: "Verify & respond", link: "/webhooks/verify" },
        ],
      },
      {
        text: "SDK",
        collapsed: false,
        items: [
          { text: "@sweepconsole/node", link: "/sdk/node" },
          { text: "@sweepconsole/js", link: "/sdk/js" },
        ],
      },
    ],

    // Local index, built at compile time. No third party sees what anyone
    // searches for, and it works offline.
    search: { provider: "local" },

    socialLinks: [{ icon: "github", link: "https://github.com/u4believe/sweep-console" }],

    editLink: {
      pattern: "https://github.com/u4believe/sweep-console/edit/main/apps/docs/:path",
      text: "Edit this page on GitHub",
    },

    footer: {
      message: "Recurring USDC payments, settled on Arc.",
      copyright: "© 2026 Sweep Console",
    },

    outline: { level: [2, 3], label: "On this page" },
  },

  markdown: {
    theme: { light: "github-light", dark: "github-dark" },
    lineNumbers: false,
  },
});
