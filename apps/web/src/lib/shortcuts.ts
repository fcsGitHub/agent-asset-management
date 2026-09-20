// 快捷键单一真源：浮层渲染与 window handler 都从这里读（吸收 AgentPM shortcuts.ts）。
export interface ShortcutDef {
  keys: string;
  label: string;
}

export const SHORTCUTS: ShortcutDef[] = [
  { keys: "Ctrl/⌘ + K", label: "打开命令栏（搜索资产 / 跳转页面 / AI 解析指令）" },
  { keys: "?", label: "显示快捷键帮助" },
  { keys: "Esc", label: "关闭浮层（命令栏 / 帮助）" },
  { keys: "g 然后 d", label: "跳到总览仪表盘" },
  { keys: "g 然后 w", label: "跳到工作台" },
  { keys: "g 然后 a", label: "跳到团队动态" },
  { keys: "g 然后 r", label: "跳到审批" },
  { keys: "g 然后 m", label: "跳到关系图谱" },
];

/** 输入控件聚焦时不触发快捷键（防劫持）。 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}

export type PageKey = "dashboard" | "workbench" | "activity" | "approvals" | "graph";

/** g-前缀两级跳转：记录第一次按下的 g，500ms 内的第二个键完成跳转。 */
export function createGoPrefixHandler(navigate: (page: PageKey) => void) {
  let armed = false;
  let timer: number | undefined;
  return (e: KeyboardEvent): void => {
    if (armed) {
      armed = false;
      window.clearTimeout(timer);
      const map: Record<string, PageKey> = { d: "dashboard", w: "workbench", a: "activity", r: "approvals", m: "graph" };
      const page = map[e.key.toLowerCase()];
      if (page) {
        e.preventDefault();
        navigate(page);
      }
      return;
    }
    if (e.key.toLowerCase() === "g") {
      armed = true;
      timer = window.setTimeout(() => {
        armed = false;
      }, 500);
    }
  };
}
