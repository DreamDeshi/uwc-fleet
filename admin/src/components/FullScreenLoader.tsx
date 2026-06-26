import { colors } from "@/theme";

// Centered spinner used as the Suspense fallback for lazy route/page chunks and
// while auth status resolves.
export function FullScreenLoader() {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: colors.bg,
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          border: `3px solid ${colors.border}`,
          borderTopColor: colors.blue,
          borderRadius: "50%",
          animation: "uwc-spin 0.8s linear infinite",
        }}
      />
    </div>
  );
}
