import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { colors, radius, shadow } from "@/theme";
import { Button } from "@/components/ui";
import { apiErrorMessage } from "@/services/api";

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(phone.trim(), password);
      navigate("/", { replace: true });
    } catch (err) {
      // login() throws a plain Error for the non-admin guard; otherwise it's axios.
      setError(err instanceof Error && !(err as { response?: unknown }).response ? err.message : apiErrorMessage(err, "Login failed."));
    } finally {
      setBusy(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "13px 14px",
    borderRadius: radius.md,
    border: `1px solid ${colors.border}`,
    fontSize: 15,
    outline: "none",
  };

  return (
    <div
      style={{
        minHeight: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: `linear-gradient(135deg, ${colors.navy} 0%, ${colors.blue} 100%)`,
        padding: 20,
      }}
    >
      <div style={{ width: 400, maxWidth: "100%" }}>
        {/* Brand */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, marginBottom: 22 }}>
          <div style={{ width: 48, height: 48, background: colors.yellow, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="28" height="19" viewBox="0 0 22 15" fill="none">
              <rect x="0" y="4" width="14" height="9" rx="2" fill={colors.blue} />
              <rect x="14" y="6" width="8" height="7" rx="2" fill={colors.blue} />
              <circle cx="4" cy="13" r="2" fill={colors.blue} />
              <circle cx="18" cy="13" r="2" fill={colors.blue} />
            </svg>
          </div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: "#fff", letterSpacing: 0.5 }}>UWC TRUCKING</div>
            <div style={{ fontSize: 12, color: colors.yellow, fontWeight: 600, letterSpacing: 1.5 }}>FLEET MANAGEMENT</div>
          </div>
        </div>

        <div style={{ background: colors.card, borderRadius: radius.xl, padding: 30, boxShadow: shadow.floating }}>
          <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Administrator Sign In</div>
          <div style={{ fontSize: 14, color: colors.textMuted, marginBottom: 22 }}>
            Fleet management dashboard — admin access only.
          </div>

          <form onSubmit={submit}>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Phone Number</div>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+60100000001"
                autoFocus
                style={inputStyle}
              />
            </div>
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Password</div>
              <div style={{ position: "relative" }}>
                <input
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  style={inputStyle}
                />
                <button
                  type="button"
                  onClick={() => setShowPw((s) => !s)}
                  style={{
                    position: "absolute",
                    right: 12,
                    top: "50%",
                    transform: "translateY(-50%)",
                    border: "none",
                    background: "transparent",
                    color: colors.textMuted,
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {showPw ? "Hide" : "Show"}
                </button>
              </div>
            </div>

            {error && (
              <div
                style={{
                  background: colors.redTint,
                  color: colors.red,
                  borderRadius: radius.md,
                  padding: "10px 12px",
                  fontSize: 14,
                  fontWeight: 500,
                  marginBottom: 16,
                }}
              >
                {error}
              </div>
            )}

            <Button type="submit" variant="primary" full disabled={busy || !phone || !password}>
              {busy ? "Signing in…" : "Sign In"}
            </Button>
          </form>
        </div>

        <div style={{ textAlign: "center", fontSize: 13, color: "rgba(255,255,255,0.6)", marginTop: 16 }}>
          UWC Trucking Management System
        </div>
      </div>
    </div>
  );
}
