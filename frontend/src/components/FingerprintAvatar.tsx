import React, { useMemo, useState } from 'react';

const DEVICE_ID_KEY = 'excalidash-device-id';

const getOrCreateDeviceId = (): string => {
  if (typeof window === 'undefined') return 'server';
  const existing = localStorage.getItem(DEVICE_ID_KEY);
  if (existing) return existing;

  const generated =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  localStorage.setItem(DEVICE_ID_KEY, generated);
  return generated;
};

const fnv1a = (input: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

const toHsl = (n: number) => {
  const hue = n % 360;
  const sat = 60 + (n % 20);
  const light = 45 + (n % 10);
  return `hsl(${hue} ${sat}% ${light}%)`;
};

const buildPattern = (seed: string) => {
  let x = fnv1a(seed);
  const nextBit = () => {
    // xorshift32
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) & 1;
  };

  const cells: boolean[][] = Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => false));

  // Generate left 3 columns, mirror to 5.
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const on = nextBit() === 1;
      cells[row][col] = on;
      cells[row][4 - col] = on;
    }
  }

  const foreground = toHsl(x);
  const background = 'hsl(0 0% 98%)';
  const backgroundDark = 'hsl(0 0% 12%)';

  return { cells, foreground, background, backgroundDark };
};

export const FingerprintAvatar: React.FC<{
  size?: number;
  seed?: string;
  title?: string;
  className?: string;
}> = ({ size = 32, seed, title = 'Device fingerprint', className }) => {
  const [deviceId] = useState(() => getOrCreateDeviceId());
  const effectiveSeed = seed || deviceId;

  const { cells, foreground, background, backgroundDark } = useMemo(
    () => buildPattern(effectiveSeed),
    [effectiveSeed]
  );

  const padding = 0.5;
  const viewBox = `${-padding} ${-padding} ${5 + padding * 2} ${5 + padding * 2}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      role="img"
      aria-label={title}
      className={className}
    >
      <title>{title}</title>
      <rect
        x={-padding}
        y={-padding}
        width={5 + padding * 2}
        height={5 + padding * 2}
        rx={1.4}
        fill={background}
        className="dark:hidden"
      />
      <rect
        x={-padding}
        y={-padding}
        width={5 + padding * 2}
        height={5 + padding * 2}
        rx={1.4}
        fill={backgroundDark}
        className="hidden dark:block"
      />
      {cells.map((row, r) =>
        row.map((on, c) =>
          on ? <rect key={`${r}-${c}`} x={c} y={r} width={1} height={1} rx={0.2} fill={foreground} /> : null
        )
      )}
      <rect
        x={-padding}
        y={-padding}
        width={5 + padding * 2}
        height={5 + padding * 2}
        rx={1.4}
        fill="none"
        stroke="rgba(0,0,0,0.25)"
        className="dark:stroke-neutral-700"
      />
    </svg>
  );
};
