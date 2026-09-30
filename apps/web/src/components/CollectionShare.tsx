// 集合只读分享页（M67⑤，Zenodo/HF snapshot 思想）：免登录查看冻结快照。
// 数据来自公开端点 GET /share/collections/:token——内容为创建快照时的深拷贝，
// 不随集合后续变化；不含团队/用户标识与制品内容（只有元数据与内容摘要）。
import { useEffect, useState } from "react";
import { api, ApiError } from "../api";

interface ShareItem {
  name: string; typeKey: string; typeVersion: string;
  lifecycle: string; note: string; addedAt: string; contentDigest: string | null;
}
interface ShareView {
  collectionName: string;
  createdAt: string;
  payload: { description: string; items: ShareItem[] };
}

const LIFECYCLE_LABEL: Record<string, string> = { archived: "已归档", deprecated: "已弃用", active: "进行中" };

export function CollectionShare({ token }: { token: string }) {
  const [data, setData] = useState<ShareView | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void api<ShareView>(`/share/collections/${token}`)
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : "快照不存在或链接无效"));
  }, [token]);

  return (
    <div style={{ maxWidth: 880, margin: "40px auto", padding: "0 20px", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ fontSize: 12.5, opacity: 0.7, marginBottom: 10 }}>
        Team Asset Workspace（TAW）· 集合只读分享快照
      </div>
      {error && <div className="state error" style={{ color: "#a33a3a" }}>{error}</div>}
      {!data && !error && <div style={{ opacity: 0.7 }}>加载快照…</div>}
      {data && (
        <div className="card" style={{ border: "1px solid #ddd", borderRadius: 10, padding: "16px 20px" }}>
          <h2 style={{ margin: "0 0 4px" }}>{data.collectionName}</h2>
          <div style={{ fontSize: 12.5, opacity: 0.7, marginBottom: 4 }}>
            快照冻结于 {new Date(data.createdAt).toLocaleString()} · 共 {data.payload.items.length} 项——集合后续变化不影响本页
          </div>
          {data.payload.description && <p style={{ margin: "6px 0 12px" }}>{data.payload.description}</p>}
          <table className="list" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                <th style={{ padding: "6px 8px" }}>名称</th>
                <th style={{ padding: "6px 8px" }}>类型</th>
                <th style={{ padding: "6px 8px" }}>生命周期</th>
                <th style={{ padding: "6px 8px" }}>备注</th>
                <th style={{ padding: "6px 8px" }} title="当前修订内容摘要（可与你拿到的包核对）">内容摘要</th>
              </tr>
            </thead>
            <tbody>
              {data.payload.items.map((it, i) => (
                <tr key={`${it.name}-${i}`} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: "6px 8px", fontWeight: 550 }}>{it.name}</td>
                  <td style={{ padding: "6px 8px" }}><code>{it.typeKey}</code> v{it.typeVersion}</td>
                  <td style={{ padding: "6px 8px" }}>{LIFECYCLE_LABEL[it.lifecycle] ?? it.lifecycle}</td>
                  <td style={{ padding: "6px 8px", opacity: 0.8 }}>{it.note || "—"}</td>
                  <td style={{ padding: "6px 8px" }}><code style={{ fontSize: 11 }}>{it.contentDigest?.slice(0, 12) ?? "—"}…</code></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: 12, opacity: 0.6, marginTop: 12 }}>
            本页为只读快照：不包含文件本体与团队信息；如需下载制品或查看最新内容，请联系分享方。
          </div>
        </div>
      )}
    </div>
  );
}
