/**
 * Minimal ambient types for the `qrcode` package, which ships no declarations.
 *
 * Only `toDataURL` is declared because that is the whole surface the renderer
 * uses (the Weixin login QR code). Widen this if another call site appears.
 */
declare module "qrcode" {
  export interface QRCodeToDataURLOptions {
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
    margin?: number;
    width?: number;
    scale?: number;
    color?: { dark?: string; light?: string };
  }

  export function toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>;

  const QRCode: { toDataURL: typeof toDataURL };
  export default QRCode;
}
