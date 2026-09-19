import { useEffect, useState } from "react";
import { api } from "./api";
import { Login } from "./pages/Login";
import { Workbench } from "./pages/Workbench";

export interface Me {
  userId: string;
  email: string;
  displayName: string;
  teams: { teamId: string; role: string; name: string }[];
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [connError, setConnError] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const m = await api<Me>("/auth/me");
        setMe(m);
      } catch {
        setConnError(false);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div className="state">正在加载…</div>;
  if (!me) return <Login onLoggedIn={setMe} />;
  return <Workbench me={me} onLoggedOut={() => setMe(null)} />;
}
