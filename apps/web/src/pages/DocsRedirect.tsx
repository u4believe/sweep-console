import { useEffect } from "react";
import { docsUrlForHash } from "@/lib/docs";

/**
 * /docs, which is now somewhere else.
 *
 * The documentation moved to its own site. This route stays so that every
 * link anyone saved, every search result, and every "see the docs" in an old
 * email still arrives somewhere useful rather than at a 404 — and so that a
 * deep link keeps its depth: /docs#rail-charges lands on the charges page,
 * not the home page.
 *
 * location.replace, not assign: the reader never chose to be here, so it does
 * not belong in their history where Back would bounce them straight out again.
 */
export function DocsRedirect() {
  useEffect(() => {
    window.location.replace(docsUrlForHash(window.location.hash));
  }, []);

  // Visible for the instant before the browser leaves, and the whole page for
  // anyone whose JavaScript did not run — hence the real link.
  return (
    <main
      style={{
        minHeight: "60vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        textAlign: "center",
      }}
    >
      <div>
        <p style={{ fontSize: 14, color: "var(--color-neutral-700)", margin: "0 0 10px" }}>
          The documentation has moved.
        </p>
        <a href={docsUrlForHash(typeof window === "undefined" ? "" : window.location.hash)}>
          Continue to docs.sweepconsole.xyz
        </a>
      </div>
    </main>
  );
}
