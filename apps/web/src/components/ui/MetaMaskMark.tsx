/**
 * The MetaMask fox, redrawn as flat facets.
 *
 * Built from the brand mark rather than traced from it: broad ears with a dark
 * outer half and a bright inner one, one light face panel, dark eye bars, a
 * dark muzzle and a white chin. Enough facets to be recognised, few enough to
 * stay legible at 18px beside a button label, and no binary to ship.
 *
 * Literal colours on purpose — a brand mark that followed the page's theme
 * would stop being the brand mark.
 */
const DARK = "#70280E";
const ORANGE = "#F5841F";
const LIGHT = "#FA9E6B";
const CHIN = "#E7EBEB";

export function MetaMaskMark({ height = 18 }: { height?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={height}
      height={height}
      aria-hidden="true"
      style={{ display: "block", flex: "none" }}
    >
      {/* head */}
      <polygon
        points="1.3,10.6 10.0,6.3 12,5.9 14.0,6.3 22.7,10.6 21.2,21.8 14.8,21.5 12,22.6 9.2,21.5 2.8,21.8"
        fill={ORANGE}
      />
      {/* ears — bright inner, dark outer */}
      <polygon points="2.8,1.4 5.0,9.6 9.6,7.2" fill={ORANGE} />
      <polygon points="21.2,1.4 19.0,9.6 14.4,7.2" fill={ORANGE} />
      <polygon points="2.8,1.4 1.3,10.6 5.0,9.6" fill={DARK} />
      <polygon points="21.2,1.4 22.7,10.6 19.0,9.6" fill={DARK} />
      {/* face */}
      <polygon
        points="4.0,11.4 10.0,7.0 12,6.6 14.0,7.0 20.0,11.4 19.0,18.4 15.0,20.2 12,21.0 9.0,20.2 5.0,18.4"
        fill={LIGHT}
      />
      <polygon points="5.4,12.6 9.8,14.0 9.8,15.6 5.4,14.4" fill={DARK} />
      <polygon points="18.6,12.6 14.2,14.0 14.2,15.6 18.6,14.4" fill={DARK} />
      <polygon points="10.4,17.2 13.6,17.2 12.9,19.8 11.1,19.8" fill={DARK} />
      <polygon points="9.2,19.8 14.8,19.8 13.6,22.6 10.4,22.6" fill={CHIN} />
    </svg>
  );
}
