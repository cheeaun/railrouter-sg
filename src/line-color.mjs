// Colour helpers shared by the trains panel and the station arrival board, so
// a line's ink is chosen by one rule everywhere.

// Black or white, whichever reads better on a line colour. Uses relative
// luminance so pale lines (the Circle Line's orange, the LRT greys) get dark
// text instead of unreadable white.
export function contrastInk(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map(
    (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4),
  );
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.35 ? '#111' : '#fff';
}
