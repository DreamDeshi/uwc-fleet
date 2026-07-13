// CSV export — NATIVE stub (the web build resolves csvShare.web.ts instead).
// Filled in with a real share-sheet flow (expo-sharing / expo-file-system)
// when the Reports screen lands in Phase 4; nothing calls this before then.
export async function shareCsv(_filename: string, _csv: string): Promise<void> {
  throw new Error("CSV export on native arrives with the Reports screen (Phase 4).");
}
