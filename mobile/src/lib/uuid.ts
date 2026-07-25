// RFC-4122 v4 UUID. Used only as client OPERATION ids (idempotency keys) — not
// security-sensitive — so a Math.random source is fine, and it avoids a native
// crypto dependency that behaves differently across Expo web/native. The format
// matches the server's strict UUID validation.
export function uuidv4(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
