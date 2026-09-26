// 待办徽标即时刷新（M42）：任何面板完成影响待处理计数的变更后调用，
// Workbench 监听该事件立即重取审批/提案/语义候选计数（不等 30s 轮询）。
export const refreshBadges = (): void => {
  window.dispatchEvent(new Event("taw:badges-refresh"));
};
