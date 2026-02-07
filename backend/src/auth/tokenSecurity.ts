import crypto from "crypto";

export const hashTokenForStorage = (token: string): string =>
  crypto.createHash("sha256").update(token, "utf8").digest("hex");

export const getTokenLookupCandidates = (token: string): string[] => {
  const candidates = new Set<string>();
  candidates.add(token);
  candidates.add(hashTokenForStorage(token));
  return [...candidates];
};
