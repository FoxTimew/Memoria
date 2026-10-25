'use client';
import { useEffect, useRef, useState } from 'react';
/** Only local canvas pixels; the secret never becomes an image URL or a network request. */
export function TotpQr({ uri }: { uri: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const target = canvas.current;
    setFailed(false);
    void import('qrcode')
      .then(async (qr) => {
        if (active && target)
          await qr.toCanvas(target, uri, { errorCorrectionLevel: 'M', margin: 4, width: 280 });
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      target?.getContext('2d')?.clearRect(0, 0, target.width, target.height);
    };
  }, [uri]);
  return failed ? (
    <p>Le QR code n’a pas pu être affiché. Utilisez la clé manuelle ci-dessous.</p>
  ) : (
    <canvas
      ref={canvas}
      role="img"
      aria-label="QR code d’enrôlement TOTP"
      className="my-4 max-w-full"
    />
  );
}
