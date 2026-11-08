/**
 * The ONE origin this deployment builds its own links with.
 *
 * Thirteen places were resolving this independently, each with its own
 * fallback chain, and two of them fell back to APP_URL — which is
 * legitimately a COMMA-SEPARATED LIST, because CORS needs every origin that
 * may call the API. On the sandbox that value is
 *
 *   https://www.sweepconsole.xyz,https://sweepconsole.xyz, …,https://sandbox.sweepconsole.xyz
 *
 * so those two paths were emitting links like
 * "https://www.sweepconsole.xyz,https://sweepconsole.xyz, …/rail" — a URL
 * that cannot resolve, in an email, with nothing to say it went wrong.
 *
 * APP_URL IS A LIST AND THIS IS A SINGLE VALUE. They are different questions:
 * "who may call us" versus "what do we call ourselves". Where a list arrives
 * anyway the first entry is used, because a deployment's canonical origin is
 * conventionally first and a broken link is worse than a debatable one — and
 * it says so, once, rather than silently.
 */
let warned = false;

export function appOrigin(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL ?? "http://localhost:3000";
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length > 1 && !warned) {
    warned = true;
    console.warn(
      `[app-url] ${
        process.env.NEXT_PUBLIC_APP_URL ? "NEXT_PUBLIC_APP_URL" : "APP_URL"
      } holds ${parts.length} origins; links will use the first (${parts[0]}). ` +
        `Set NEXT_PUBLIC_APP_URL to this deployment's single origin — APP_URL may be a list ` +
        `because CORS needs one, but a link cannot be.`
    );
  }

  return (parts[0] ?? "http://localhost:3000").replace(/\/+$/, "");
}
