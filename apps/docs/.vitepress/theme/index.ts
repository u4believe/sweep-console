import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import Fee from "./Fee.vue";
import "./custom.css";

/**
 * The default theme, restyled rather than replaced.
 *
 * Everything the reference design asks for — the three-column layout, the
 * section tabs, Ctrl-K search, code groups with language tabs, the appearance
 * toggle — is what VitePress already does. What it does not know is the brand
 * colour and the two typefaces, and those are CSS. A custom layout would mean
 * re-earning accessibility and keyboard behaviour that already works.
 *
 * <Fee /> is global because the rate appears on several pages and importing it
 * into each one is a step someone will forget, leaving a literal behind.
 */
export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("Fee", Fee);
  },
} satisfies Theme;
