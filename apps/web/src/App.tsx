import { useEffect, useState } from "react";
import { api } from "./api";
import { Login } from "./pages/Login";
import { Workbench } from "./pages/Workbench";
import { CollectionShare } from "./components/CollectionShare";

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
  // 集合只读分享快照（M67⑤）：/share/collection/:token 免登录公开页，不进工作台
  const shareToken = window.location.pathname.match(/^\/share\/collection\/([0-9a-f]{32})$/)?.[1];

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

  if (shareToken) return <CollectionShare token={shareToken} />;
  if (loading) return <div className="state">正在加载…</div>;
  if (!me) return <Login onLoggedIn={setMe} />;
  return <Workbench me={me} onLoggedOut={() => setMe(null)} />;
}
