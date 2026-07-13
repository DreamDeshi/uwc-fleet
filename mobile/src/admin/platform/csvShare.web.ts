// CSV export — web build: the same anchor-download the web admin uses.
// The caller is responsible for prepending CSV_BOM (lib/csv.ts) so Excel
// decodes UTF-8 names correctly.
export async function shareCsv(filename: string, csv: string): Promise<void> {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
