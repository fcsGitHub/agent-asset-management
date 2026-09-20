// 快捷键帮助浮层：SHORTCUTS 单一真源的渲染端。
import { SHORTCUTS } from "../lib/shortcuts";

export function ShortcutsOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="快捷键帮助" onMouseDown={onClose}>
      <div className="shortcuts-panel" onMouseDown={(e) => e.stopPropagation()}>
        <h3>键盘快捷键</h3>
        <table className="shortcuts-table">
          <tbody>
            {SHORTCUTS.map((s) => (
              <tr key={s.keys}>
                <td><kbd>{s.keys}</kbd></td>
                <td>{s.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button onClick={onClose}>关闭（Esc）</button>
      </div>
    </div>
  );
}
