export interface UserIdentity {
  id: string;
  name: string;
  initials: string;
  color: string;
}

const DEVICE_ID_KEY = "excalidash-device-id";

const TRANSFORMERS = [
  { name: "Optimus Prime", initials: "OP" },
  { name: "Megatron", initials: "ME" },
  { name: "Starscream", initials: "ST" },
  { name: "Bumblebee", initials: "BB" },
  { name: "Ultra Magnus", initials: "UM" },
  { name: "Shockwave", initials: "SH" },
  { name: "Soundwave", initials: "SW" },
  { name: "Ironhide", initials: "IR" },
  { name: "Ratchet", initials: "RA" },
  { name: "Prowl", initials: "PR" },
  { name: "Jazz", initials: "JA" },
  { name: "Hot Rod", initials: "HR" },
  { name: "Alpha Trion", initials: "AT" },
  { name: "Wheeljack", initials: "WH" },
  { name: "Sideswipe", initials: "SI" },
  { name: "Sunstreaker", initials: "SU" },
  { name: "Inferno", initials: "IN" },
  { name: "Grapple", initials: "GR" },
  { name: "Blaster", initials: "BL" },
  { name: "Perceptor", initials: "PE" },
  { name: "Trailbreaker", initials: "TR" },
  { name: "Cosmos", initials: "CO" },
  { name: "Warpath", initials: "WA" },
  { name: "Powerglide", initials: "PO" },
  { name: "Arcee", initials: "AR" },
  { name: "Springer", initials: "SP" },
  { name: "Kup", initials: "KU" },
  { name: "Blurr", initials: "BU" },
  { name: "Grimlock", initials: "GL" },
  { name: "Swoop", initials: "WO" },
  { name: "Skywarp", initials: "SK" },
  { name: "Thundercracker", initials: "TH" },
  { name: "Ramjet", initials: "AM" },
  { name: "Cyclonus", initials: "CY" },
  { name: "Scourge", initials: "SC" },
  { name: "Galvatron", initials: "GA" },
  { name: "Astrotrain", initials: "AS" },
  { name: "Blitzwing", initials: "BZ" },
  { name: "Rumble", initials: "RU" },
  { name: "Frenzy", initials: "FR" },
  { name: "Laserbeak", initials: "LA" },
  { name: "Ravage", initials: "RV" },
  { name: "Unicron", initials: "UN" },
  { name: "Devastator", initials: "DE" },
  { name: "Menasor", initials: "MN" },
  { name: "Bruticus", initials: "BR" },
  { name: "Motormaster", initials: "MO" },
  { name: "Scrapper", initials: "CR" },
  { name: "Mixmaster", initials: "MA" },
  { name: "Bonecrusher", initials: "BO" },
  { name: "Hook", initials: "HO" },
  { name: "Vortex", initials: "VO" },
  { name: "Swindle", initials: "WI" },
];

const COLORS = [
  "#ef4444", // red-500
  "#f97316", // orange-500
  "#f59e0b", // amber-500
  "#84cc16", // lime-500
  "#22c55e", // green-500
  "#10b981", // emerald-500
  "#14b8a6", // teal-500
  "#06b6d4", // cyan-500
  "#0ea5e9", // sky-500
  "#3b82f6", // blue-500
  "#6366f1", // indigo-500
  "#8b5cf6", // violet-500
  "#a855f7", // purple-500
  "#d946ef", // fuchsia-500
  "#ec4899", // pink-500
  "#f43f5e", // rose-500
];

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const hashString = (input: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

const getCryptoObject = (): Crypto | undefined =>
  typeof globalThis !== "undefined"
    ? globalThis.crypto || (globalThis as any).msCrypto
    : undefined;

const getSecureRandomInt = (maxExclusive: number): number => {
  if (maxExclusive <= 1) return 0;
  const cryptoObj = getCryptoObject();
  if (cryptoObj?.getRandomValues) {
    const buffer = new Uint32Array(1);
    cryptoObj.getRandomValues(buffer);
    return buffer[0] % maxExclusive;
  }
  const perfNow =
    typeof globalThis !== "undefined" &&
    typeof globalThis.performance !== "undefined" &&
    typeof globalThis.performance.now === "function"
      ? globalThis.performance.now()
      : 0;
  const seed = `${Date.now().toString(16)}:${perfNow.toString(16)}`;
  return hashString(seed) % maxExclusive;
};

const generateClientId = (): string => {
  const cryptoObj = getCryptoObject();

  if (cryptoObj?.randomUUID) {
    return cryptoObj.randomUUID();
  }

  if (cryptoObj?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // RFC 4122 variant
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
      .slice(6, 8)
      .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }

  // Final fallback for very old browsers; uniqueness window-scoped only.
  const perfNow =
    typeof globalThis !== "undefined" &&
    typeof globalThis.performance !== "undefined" &&
    typeof globalThis.performance.now === "function"
      ? globalThis.performance.now()
      : 0;
  const entropy = `${Date.now().toString(16)}-${perfNow.toString(16)}-${getSecureRandomInt(1_000_000_000).toString(16)}`;
  return `id-${hashString(entropy).toString(16)}-${hashString(`${entropy}:2`).toString(16)}`;
};

export const getOrCreateBrowserFingerprint = (): string => {
  const existing = localStorage.getItem(DEVICE_ID_KEY);
  if (existing) return existing;
  const generated = generateClientId();
  localStorage.setItem(DEVICE_ID_KEY, generated);
  return generated;
};

export const getFingerprintInitials = (seed?: string): string => {
  const fingerprint = seed || getOrCreateBrowserFingerprint();
  const hash = hashString(fingerprint);
  const first = ALPHABET[hash % ALPHABET.length];
  const second = ALPHABET[Math.floor(hash / ALPHABET.length) % ALPHABET.length];
  return `${first}${second}`;
};

export const getUserIdentity = (): UserIdentity => {
  const stored = localStorage.getItem("excalidash-user-id");
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as Partial<UserIdentity>;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.id === "string" &&
        typeof parsed.name === "string" &&
        typeof parsed.color === "string"
      ) {
        const normalized: UserIdentity = {
          id: parsed.id,
          name: parsed.name,
          color: parsed.color,
          initials:
            typeof parsed.initials === "string" && parsed.initials.length === 2
              ? parsed.initials
              : getFingerprintInitials(parsed.id),
        };
        localStorage.setItem("excalidash-user-id", JSON.stringify(normalized));
        return normalized;
      }
    } catch {
      // Fall through to regenerate identity.
    }
  }

  const deviceId = getOrCreateBrowserFingerprint();
  const randomTransformer = TRANSFORMERS[getSecureRandomInt(TRANSFORMERS.length)];
  const randomColor = COLORS[getSecureRandomInt(COLORS.length)];

  const identity: UserIdentity = {
    id: deviceId,
    name: randomTransformer.name,
    initials: getFingerprintInitials(deviceId),
    color: randomColor,
  };

  localStorage.setItem("excalidash-user-id", JSON.stringify(identity));
  return identity;
};
