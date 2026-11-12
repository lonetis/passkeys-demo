import qrcode from 'qrcode-generator';

/** Quiet zone around the code, in modules, as the QR standard requires. */
const QUIET_ZONE = 4;

/** An SVG QR code for `text`: black modules on white, sized by its viewBox. */
export function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const size = count + 2 * QUIET_ZONE;
  let modules = '';
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) modules += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`
    + `<rect width="${size}" height="${size}" fill="#fff"/><path d="${modules}" fill="#000"/></svg>`;
}
