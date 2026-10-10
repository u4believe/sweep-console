<script setup lang="ts">
/**
 * The platform fee, read from the API rather than written into the page.
 *
 * The app can get away with baking VITE_PLATFORM_FEE_BPS into its bundle,
 * because every deploy rebuilds it. This site may sit untouched for months, so
 * a literal here is a promise that goes stale silently — which is exactly what
 * happened once already: the pages said 2% while the API was configured for 3%.
 *
 * Renders the build-time fallback first so the number is never blank or
 * shifting under the reader, then corrects it if the API answers. If the fetch
 * fails — offline, CORS, API down — the fallback simply stands.
 *
 *   <Fee />        2%     the platform's share
 *   <Fee keeps />  98%    what the merchant keeps
 */
import { ref, onMounted, computed } from "vue";

const props = defineProps<{ keeps?: boolean }>();

const FALLBACK_BPS = 200;
const bps = ref(FALLBACK_BPS);

const API =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "https://api.sweepconsole.xyz";

const text = computed(() => {
  const share = props.keeps ? 10_000 - bps.value : bps.value;
  // Trailing zeros dropped, so 250 reads "2.5%" and 200 reads "2%" — the same
  // rule as lib/fee.ts in the app, so the two never disagree on formatting.
  return `${Number((share / 100).toFixed(2))}%`;
});

onMounted(async () => {
  try {
    const res = await fetch(`${API}/config`, { headers: { accept: "application/json" } });
    if (!res.ok) return;
    const body = await res.json();
    const live = Number(body?.data?.platform_fee_bps ?? body?.platform_fee_bps);
    if (Number.isFinite(live) && live >= 0 && live <= 10_000) bps.value = live;
  } catch {
    /* Fallback stands. A docs page is not worth an error state. */
  }
});
</script>

<template>
  <strong>{{ text }}</strong>
</template>
