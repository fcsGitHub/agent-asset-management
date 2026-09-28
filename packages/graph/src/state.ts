// 投影状态与脏标记。
// API 写路径在业务事务内调用 markGraphDirty（与数据变更同事务提交 = 原子盖标）；
// worker 周期读取脏团队做幂等重建。图库不可用时状态行如实留痕（last_error）。
export interface SqlClient {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/** 盖脏标记：在调用方事务内执行（withTeam 上下文），与业务写入原子提交。 */
export async function markGraphDirty(client: SqlClient, teamId: string): Promise<void> {
  await client.query(
    `INSERT INTO graph_sync_state (team_id, marked_at) VALUES ($1, now())
      ON CONFLICT (team_id) DO UPDATE SET marked_at = now()`,
    [teamId]
  );
}
