import { useState } from "react";
import { api, ApiError } from "../api";
import type { Me } from "../App";

export function Login({ onLoggedIn }: { onLoggedIn: (me: Me) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [teamName, setTeamName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "register") {
        await api<{ userId: string }>("/auth/register", {
          method: "POST",
          body: { email, password, displayName, teamName },
        });
      } else {
        await api("/auth/login", { method: "POST", body: { email, password } });
      }
      const me = await api<Me>("/auth/me");
      onLoggedIn(me);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "网络异常，请重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <h1>工作集</h1>
        <div className="sub">小型团队 LLM Agent 资产协同管理</div>
        {mode === "register" && (
          <>
            <div className="field">
              <label>姓名</label>
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required minLength={1} />
            </div>
            <div className="field">
              <label>团队名称（首个注册成员为管理员）</label>
              <input value={teamName} onChange={(e) => setTeamName(e.target.value)} required />
            </div>
          </>
        )}
        <div className="field">
          <label>邮箱</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="field">
          <label>密码{mode === "register" && "（至少 8 位）"}</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={mode === "register" ? 8 : 1} />
        </div>
        {error && <div className="error-text">{error}</div>}
        <div className="form-actions">
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "请稍候…" : mode === "login" ? "登录" : "注册并创建团队"}
          </button>
        </div>
        <div className="switch">
          {mode === "login" ? (
            <a href="#" onClick={(e) => { e.preventDefault(); setMode("register"); }}>
              没有账号？注册新团队
            </a>
          ) : (
            <a href="#" onClick={(e) => { e.preventDefault(); setMode("login"); }}>
              已有账号？直接登录
            </a>
          )}
        </div>
      </form>
    </div>
  );
}
