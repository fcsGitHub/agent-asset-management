// 受控工具网关（设计 17/18 章）。
// 分级：read（授权范围内自动执行）/ draft（草稿写入）/ human（人类高权动作，永不注册给 Agent）。
// 每次调用：校验主体与租户、重新鉴权、预算、持久化调用记录（含 denied）。
// M50 起含图数据库检索工具（graph.*）：类闭包资产检索、关联路径、多跳邻域——
// 全部显式携带 ctx.teamId 查询，租户隔离与图投影一致。
import type { PoolClient } from "pg";
import { canonicalDigest } from "@taw/domain/digest";
import { GraphUnavailableError, findShortestPath, neighborhood, resolveTypeClosure } from "@taw/graph";
import { loadOntology, typeKeyClosure } from "../ontology.js";
import { likeContains } from "../like.js";
import { flattenOntologyTree, relationsForClosure } from "@taw/domain/ontology-tree";

export type ToolTier = "read" | "draft";

/** 外部副作用已发生但结果未知（D06）：调用方必须进入对账，不得盲目重试。 */
export class UnknownOutcomeError extends Error {
  constructor(public detail: string) {
    super("外部执行结果未知，进入对账状态");
  }
}

export interface ToolContext {
  teamId: string;
  userId: string;
  projectId: string;
  runId: string;
}

export interface ToolDef {
  name: string;
  tier: ToolTier;
  description: string;
  parameters: Record<string, unknown>;
  execute(client: PoolClient, ctx: ToolContext, args: Record<string, unknown>): Promise<unknown>;
}

export const READONLY_TOOLS: ToolDef[] = [
  {
    name: "asset.search",
    tier: "read",
    description:
      "按名称关键词与类型检索本团队资产目录，返回资产与最新修订摘要。" +
      "type 是类闭包过滤（Wikidata 子类口径）：给父类自动包含全部子类，与人类目录同一语义。" +
      "含进行中与已弃用资产（lifecycle 字段如实标注，已弃用应提醒用户），不含归档资产。",
    parameters: {
      type: "object",
      properties: {
        q: { type: "string", description: "名称关键词" },
        type: { type: "string", description: "类型键（可选），如 simulation.model；含全部子类" },
      },
      required: [],
    },
    async execute(client, ctx, args) {
      const type = String(args.type ?? "");
      let typeKeys: string[] | null = null;
      if (type) {
        typeKeys = await typeKeyClosure(client, ctx.teamId, type);
        if (typeKeys.length === 0) return [];
      }
      const q = String(args.q ?? "");
      const qPattern = likeContains(q);
      const { rows } = await client.query(
        `SELECT a.id, a.name, a.lifecycle, tv.type_key, r.id AS head_revision_id, r.content_digest
           FROM assets a
           JOIN asset_type_versions tv ON tv.team_id = a.team_id AND tv.id = a.current_type_version_id
           JOIN LATERAL (SELECT id, content_digest FROM asset_revisions
                          WHERE team_id = a.team_id AND asset_id = a.id ORDER BY seq DESC LIMIT 1) r ON true
          WHERE a.team_id = $1
            AND ($2 = '' OR a.name ILIKE $5 ESCAPE '\\')
            AND ($3 = '' OR tv.type_key = ANY($4::text[]))
            AND a.lifecycle <> 'archived'
          ORDER BY (a.lifecycle = 'deprecated'), a.created_at DESC LIMIT 20`,
        [ctx.teamId, q, type, typeKeys ?? [], qPattern]
      );
      return rows;
    },
  },
  {
    name: "ontology.types",
    tier: "read",
    description:
      "浏览本团队本体（资产类型注册表的层次树）：每个类型带中文名、父类、资产计数（closureAssetCount = " +
      "选它过滤目录会命中的资产数，含全部子类）、模式声明的属性键与必填键。回答「团队有哪些门类」" +
      "「哪类资产带 owner 字段」「哪类资产最多」等问题的第一入口；查单个类型细节用 ontology.typeInfo。",
    parameters: {
      type: "object",
      properties: {
        q: { type: "string", description: "按类型键或中文名过滤（可选，不区分大小写包含）" },
      },
      required: [],
    },
    async execute(client, ctx, args) {
      const { tree } = await loadOntology(client, ctx.teamId);
      const q = String(args.q ?? "").trim().toLowerCase();
      const flat = flattenOntologyTree(tree);
      const hit = q
        ? flat.filter(
            (n) => n.key.toLowerCase().includes(q) || n.title.toLowerCase().includes(q)
          )
        : flat;
      return {
        count: hit.length,
        types: hit.map((n) => ({
          typeKey: n.key,
          title: n.title,
          parentKey: n.parentKey,
          depth: n.depth,
          assetCount: n.assetCount,
          closureAssetCount: n.closureAssetCount,
          subclassKeys: n.subclassKeys,
          propertyKeys: n.propertyKeys,
          requiredKeys: n.requiredKeys,
          requiresTestEvidence: n.requiresTestEvidence,
        })),
      };
    },
  },
  {
    name: "ontology.typeInfo",
    tier: "read",
    description:
      "查单个资产类型的登记口径（本体层细节）：类型链（自身+全部祖先，子类型须满足链上全部定义）与每级" +
      "必填字段、模式声明属性键、子类闭包、该闭包可挂的关系类型（domain/range 口径，asSource/asTarget " +
      "标注适用侧）与资产计数。回答「登记 X 要填什么」「哪些关系能连它」「它有哪些子类」。",
    parameters: {
      type: "object",
      properties: {
        typeKey: { type: "string", description: "资产类型键，如 simulation.model" },
      },
      required: ["typeKey"],
    },
    async execute(client, ctx, args) {
      const typeKey = String(args.typeKey ?? "").trim();
      if (!/^[a-zA-Z][a-zA-Z0-9.\-]{0,63}$/.test(typeKey)) {
        throw new Error("typeKey 非法：字母开头，仅含字母/数字/点/连字符，如 simulation.model");
      }
      const { tree, relations } = await loadOntology(client, ctx.teamId);
      const flat = flattenOntologyTree(tree);
      const node = flat.find((n) => n.key === typeKey);
      if (!node) {
        throw new Error(
          `类型「${typeKey}」不在本团队本体中（可先用 ontology.types 浏览现有类型）`
        );
      }
      // 类型链（子→父→…→根）：沿 parentKey 上溯（树构建已做环防御）
      const byKey = new Map(flat.map((n) => [n.key, n]));
      const chain: { typeKey: string; title: string; version: string; requiredKeys: string[]; propertyKeys: string[] }[] = [];
      let cursor: (typeof node) | null = node;
      while (cursor) {
        chain.push({
          typeKey: cursor.key,
          title: cursor.title,
          version: cursor.version,
          requiredKeys: cursor.requiredKeys,
          propertyKeys: cursor.propertyKeys,
        });
        cursor = cursor.parentKey ? (byKey.get(cursor.parentKey) ?? null) : null;
      }
      const closureKeys = [node.key, ...node.subclassKeys];
      return {
        typeKey: node.key,
        title: node.title,
        version: node.version,
        parentKey: node.parentKey,
        chain,
        requiredAll: [...new Set(chain.flatMap((c) => c.requiredKeys))].sort(),
        subclassKeys: node.subclassKeys,
        assetCount: node.assetCount,
        closureAssetCount: node.closureAssetCount,
        requiresTestEvidence: node.requiresTestEvidence,
        relations: relationsForClosure(closureKeys, relations),
      };
    },
  },
  {
    name: "asset.getRevision",
    tier: "read",
    description: "查看本团队资产某修订的属性与制品摘要；不传 revisionId 时读取最新修订（head）。",
    parameters: {
      type: "object",
      properties: {
        assetId: { type: "string" },
        revisionId: { type: "string", description: "可选；缺省读取该资产最新修订" },
      },
      required: ["assetId"],
    },
    async execute(client, ctx, args) {
      const assetId = String(args.assetId ?? "");
      const revisionId = String(args.revisionId ?? "");
      const { rows } = revisionId
        ? await client.query(
            `SELECT r.id, r.seq, r.properties, r.content_digest, r.created_at
               FROM asset_revisions r WHERE r.team_id = $1 AND r.asset_id = $2 AND r.id = $3`,
            [ctx.teamId, assetId, revisionId]
          )
        : await client.query(
            `SELECT r.id, r.seq, r.properties, r.content_digest, r.created_at
               FROM asset_revisions r WHERE r.team_id = $1 AND r.asset_id = $2 ORDER BY seq DESC LIMIT 1`,
            [ctx.teamId, assetId]
          );
      if (!rows[0]) throw new Error("修订不存在或与资产不匹配");
      await recordUsage(client, ctx.teamId, assetId, "agent_read", ctx.userId);
      // 弃用告警（M70，Dependabot deprecation 锚点）：读取如实告知不阻断——
      // Agent 应把弃用与继任者转述给用户，而不是静默读走
      const dep = await client.query(
        `SELECT a.lifecycle, a.deprecation_note, s.name AS successor_name
           FROM assets a LEFT JOIN assets s ON s.team_id = a.team_id AND s.id = a.successor_asset_id
          WHERE a.team_id = $1 AND a.id = $2`,
        [ctx.teamId, assetId]
      );
      const deprecation = dep.rows[0]?.lifecycle === "deprecated"
        ? { warning: "该资产已被标记弃用，请提醒用户改用继任者", note: dep.rows[0].deprecation_note ?? "", successor: dep.rows[0].successor_name ?? null }
        : null;
      const arts = await client.query(
        `SELECT blob_digest, artifact_role, original_name FROM revision_artifacts WHERE team_id = $1 AND revision_id = $2`,
        [ctx.teamId, String(rows[0].id)]
      );
      return { ...rows[0], deprecation, artifacts: arts.rows };
    },
  },
  {
    name: "relation.query",
    tier: "read",
    description: "查询某资产的正向/反向关系（不含候选提议）。",
    parameters: {
      type: "object",
      properties: { assetId: { type: "string" } },
      required: ["assetId"],
    },
    async execute(client, ctx, args) {
      const assetId = String(args.assetId ?? "");
      const out = await client.query(
        `SELECT rt.type_key, ta.name AS target FROM relation_assertions ra
           JOIN relation_type_versions rt ON rt.team_id = ra.team_id AND rt.id = ra.relation_type_version_id
           JOIN assets ta ON ta.team_id = ra.team_id AND ta.id = ra.target_asset_id
          WHERE ra.team_id = $1 AND ra.source_asset_id = $2 AND ra.status = 'confirmed'`,
        [ctx.teamId, String(args.assetId)]
      );
      const inc = await client.query(
        `SELECT rt.type_key, sa.name AS source FROM relation_assertions ra
           JOIN relation_type_versions rt ON rt.team_id = ra.team_id AND rt.id = ra.relation_type_version_id
           JOIN assets sa ON sa.team_id = ra.team_id AND sa.id = ra.source_asset_id
          WHERE ra.team_id = $1 AND ra.target_asset_id = $2 AND ra.status = 'confirmed'`,
        [ctx.teamId, String(args.assetId)]
      );
      await recordUsage(client, ctx.teamId, assetId, "agent_read", ctx.userId);
      return { outgoing: out.rows, incoming: inc.rows };
    },
  },
  {
    name: "graph.assetsByType",
    tier: "read",
    description:
      "按资产类型检索资产（本体检索：默认包含该类型及其全部子类的类闭包，如检索 analysis.asset 会同时命中其子类 sim.report 下的资产）。" +
      "图数据库驱动；图库不可用时自动回落 SQL 并在 engine 字段如实标注（graph / sql-fallback / sql）。" +
      "返回进行中与已弃用资产（lifecycle 字段如实标注；已弃用应提醒用户并转述继任者），归档资产不返回，最多 20 条。",
    parameters: {
      type: "object",
      properties: {
        typeKey: { type: "string", description: "资产类型键（type_key），如 simulation.model" },
        q: { type: "string", description: "名称关键词（可选）" },
        includeSubclasses: { type: "boolean", description: "是否包含全部子类，默认 true" },
      },
      required: ["typeKey"],
    },
    async execute(client, ctx, args) {
      const typeKey = String(args.typeKey ?? "").trim();
      if (!/^[a-zA-Z][a-zA-Z0-9.\-]{0,63}$/.test(typeKey)) {
        throw new Error("typeKey 非法：字母开头，仅含字母/数字/点/连字符，如 simulation.model");
      }
      const includeSubclasses = args.includeSubclasses === undefined ? true : Boolean(args.includeSubclasses);
      const q = String(args.q ?? "").slice(0, 100);
      let engine: "graph" | "sql-fallback" | "sql" = "sql";
      let keys = [typeKey];
      if (includeSubclasses) {
        const r = await resolveTypeClosure((sql, params) => client.query(sql, params as never[]), ctx.teamId, typeKey);
        engine = r.engine;
        keys = r.keys;
      }
      const { rows } = await client.query(
        `SELECT a.id, a.name, a.lifecycle, tv.type_key, tv.title AS type_title
           FROM assets a
           JOIN asset_type_versions tv ON tv.team_id = a.team_id AND tv.id = a.current_type_version_id
          WHERE a.team_id = $1 AND tv.type_key = ANY($2::text[])
            AND ($3 = '' OR a.name ILIKE $4 ESCAPE '\\') AND a.lifecycle IN ('active', 'deprecated')
          ORDER BY (a.lifecycle = 'deprecated'), a.name LIMIT 20`,
        [ctx.teamId, keys, q, likeContains(q)]
      );
      return { engine, keys, count: rows.length, assets: rows };
    },
  },
  {
    name: "graph.path",
    tier: "read",
    description:
      "查询两个资产之间的最短关联路径（沿已确认关系，无向）。两端均可传 assetId 或 name（名称精确匹配优先，其次团队别名，唯一模糊命中可用，多命中会列出候选要求改用 id）。" +
      "找不到路径时如实返回 found=false；图数据库不可用时如实报错（不做降级猜测）。",
    parameters: {
      type: "object",
      properties: {
        fromAssetId: { type: "string", description: "起点资产 id（与 fromName 二选一）" },
        fromName: { type: "string", description: "起点资产名（与 fromAssetId 二选一）" },
        toAssetId: { type: "string", description: "终点资产 id（与 toName 二选一）" },
        toName: { type: "string", description: "终点资产名（与 toAssetId 二选一）" },
      },
      required: [],
    },
    async execute(client, ctx, args) {
      const from = await resolveAssetRef(client, ctx.teamId, { assetId: args.fromAssetId, name: args.fromName }, "from");
      const to = await resolveAssetRef(client, ctx.teamId, { assetId: args.toAssetId, name: args.toName }, "to");
      if (from.id === to.id) throw new Error("from 与 to 是同一资产");
      await recordUsage(client, ctx.teamId, from.id, "agent_read", ctx.userId);
      await recordUsage(client, ctx.teamId, to.id, "agent_read", ctx.userId);
      let path;
      try {
        path = await findShortestPath(ctx.teamId, from.id, to.id);
      } catch (err) {
        if (err instanceof GraphUnavailableError) {
          throw new Error(`图数据库不可用，路径检索暂不可用：${err.message}`);
        }
        throw err;
      }
      if (!path) return { found: false, from, to };
      return {
        found: true,
        hops: path.edges.length,
        from,
        to,
        nodes: path.nodes.map((n) => ({ assetId: n.assetId, name: n.name, typeKey: n.typeKey })),
        edges: path.edges.map((e) => ({ relKey: e.relKey, source: e.source, target: e.target })),
      };
    },
  },
  {
    name: "graph.neighbors",
    tier: "read",
    description:
      "查看某资产的多跳关系邻域（图数据库；深度 1–3，默认 2）。返回邻域内的资产与关系边（不含类型层次边）。可传 assetId 或 name（名称/团队别名均可）。",
    parameters: {
      type: "object",
      properties: {
        assetId: { type: "string", description: "资产 id（与 name 二选一）" },
        name: { type: "string", description: "资产名（与 assetId 二选一）" },
        depth: { type: "number", description: "跳数 1–3，默认 2" },
      },
      required: [],
    },
    async execute(client, ctx, args) {
      const asset = await resolveAssetRef(client, ctx.teamId, { assetId: args.assetId, name: args.name }, "asset");
      await recordUsage(client, ctx.teamId, asset.id, "agent_read", ctx.userId);
      const depth = args.depth === undefined ? 2 : Math.min(Math.max(Math.trunc(Number(args.depth)), 1), 3);
      let sub;
      try {
        sub = await neighborhood(ctx.teamId, asset.id, depth);
      } catch (err) {
        if (err instanceof GraphUnavailableError) {
          throw new Error(`图数据库不可用，邻域检索暂不可用：${err.message}`);
        }
        throw err;
      }
      if (!sub.seed) {
        return { found: false, reason: "projection-stale", hint: "该资产尚未同步进图库投影，请稍候重试", assetId: asset.id, name: asset.name };
      }
      return {
        found: true,
        depth,
        assetId: asset.id,
        name: asset.name,
        nodes: sub.nodes.map((n) => ({ assetId: n.assetId, name: n.name, typeKey: n.typeKey })),
        edges: sub.edges.map((e) => ({ relKey: e.relKey, source: e.source, target: e.target })),
      };
    },
  },
  {
    name: "collection.search",
    tier: "read",
    description:
      "列出本团队的资产集合（人工策展的跨类型资产组，如权威榜单、新人入门包、评审材料包）。" +
      "可按名称关键词过滤，返回集合名、描述与条目数。看集合内容用 collection.items。",
    parameters: {
      type: "object",
      properties: { q: { type: "string", description: "名称关键词（可选）" } },
      required: [],
    },
    async execute(client, ctx, args) {
      const kw = String(args.q ?? "").slice(0, 80);
      const { rows } = await client.query(
        `SELECT c.id, c.name, c.description,
                (SELECT count(*)::int FROM asset_collection_items i WHERE i.team_id = c.team_id AND i.collection_id = c.id) AS item_count
           FROM asset_collections c
          WHERE c.team_id = $1 AND ($2 = '' OR c.name ILIKE $3 ESCAPE '\\')
          ORDER BY c.created_at DESC LIMIT 20`,
        [ctx.teamId, kw, likeContains(kw)]
      );
      return rows;
    },
  },
  {
    name: "collection.items",
    tier: "read",
    description:
      "列出某个集合的条目资产（名称、类型、生命周期、收录备注），回答「某集合里有什么」。" +
      "集合传名称（精确匹配）或 id，不确定集合名可先用 collection.search 查。",
    parameters: {
      type: "object",
      properties: {
        collection: { type: "string", description: "集合名称或 id" },
      },
      required: ["collection"],
    },
    async execute(client, ctx, args) {
      const collection = await resolveCollectionRef(client, ctx.teamId, args.collection);
      const { rows } = await client.query(
        `SELECT i.note, i.added_at, a.id, a.name, a.lifecycle,
                COALESCE(tv.type_key, '') AS type_key
           FROM asset_collection_items i
           JOIN assets a ON a.team_id = i.team_id AND a.id = i.asset_id
           LEFT JOIN asset_type_versions tv ON tv.team_id = a.team_id AND tv.id = a.current_type_version_id
          WHERE i.team_id = $1 AND i.collection_id = $2
          ORDER BY i.added_at
          LIMIT 50`,
        [ctx.teamId, collection.id]
      );
      for (const r of rows) await recordUsage(client, ctx.teamId, String(r.id), "agent_read", ctx.userId);
      return {
        collectionId: collection.id,
        collectionName: collection.name,
        count: rows.length,
        items: rows,
      };
    },
  },
  {
    name: "issue.list",
    tier: "read",
    description:
      "列出本项目的 Issue 工单，回答「现在有哪些待处理的问题/缺陷」。默认只看未结工单" +
      "（open + in_progress）；status=all 查全部（含已解决/已关闭）。可按标题/正文关键词过滤。",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["open", "in_progress", "resolved", "closed", "all"],
          description: "状态过滤，默认未结（open+in_progress）",
        },
        q: { type: "string", description: "标题/正文关键词（可选）" },
      },
      required: [],
    },
    async execute(client, ctx, args) {
      const status = String(args.status ?? "");
      const kw = String(args.q ?? "").slice(0, 80);
      const { rows } = await client.query(
        `SELECT i.id, i.title, i.status, i.created_at, a.name AS asset_name,
                u.display_name AS created_by_name
           FROM issues i
           LEFT JOIN assets a ON a.team_id = i.team_id AND a.id = i.asset_id
           JOIN users u ON u.id = i.created_by
          WHERE i.team_id = $1 AND i.project_id = $2
            AND ($3 = '' OR i.title ILIKE $4 ESCAPE '\\' OR i.body ILIKE $4 ESCAPE '\\')
            AND ($5 = 'all' OR ($5 = '' AND i.status IN ('open', 'in_progress')) OR i.status = $5)
          ORDER BY i.created_at DESC LIMIT 20`,
        [ctx.teamId, ctx.projectId, kw, likeContains(kw), status]
      );
      return { count: rows.length, issues: rows };
    },
  },
];

/** 使用度事件埋点（M55）：agent_read 随工具事务提交（runner 外层 withTeam 提交）。
 *  best-effort：埋点失败不影响工具结果。 */
async function recordUsage(
  client: PoolClient,
  teamId: string,
  assetId: string,
  kind: "agent_read",
  actorId: string
): Promise<void> {
  if (!/^[0-9a-f-]{36}$/.test(assetId)) return;
  try {
    await client.query(
      `INSERT INTO usage_events (team_id, asset_id, kind, actor_id) VALUES ($1,$2,$3,$4)`,
      [teamId, assetId, kind, actorId]
    );
  } catch {
    // 使用度计数是增强信号，绝不拖垮工具调用本身
  }
}

/** 资产端点解析（graph.path / graph.neighbors 共用）：assetId 优先；name 精确匹配优先，
 *  其次别名精确命中（M55），唯一模糊命中可用，多命中列出候选让模型改用 id。
 *  租户内解析（RLS 上下文由调用方事务决定）。 */
async function resolveAssetRef(
  client: PoolClient,
  teamId: string,
  ref: { assetId?: unknown; name?: unknown },
  side: string
): Promise<{ id: string; name: string }> {
  const assetId = typeof ref.assetId === "string" ? ref.assetId.trim() : "";
  const name = typeof ref.name === "string" ? ref.name.trim() : "";
  if (assetId) {
    if (!/^[0-9a-f-]{36}$/.test(assetId)) throw new Error(`${side}.assetId 不是合法 UUID`);
    const { rows } = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM assets WHERE team_id = $1 AND id = $2`,
      [teamId, assetId]
    );
    if (!rows[0]) throw new Error(`${side}.assetId 不存在于本团队`);
    return { id: rows[0].id, name: rows[0].name };
  }
  if (name) {
    if (name.length > 256) throw new Error(`${side}.name 过长`);
    const exact = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM assets WHERE team_id = $1 AND name = $2 LIMIT 2`,
      [teamId, name]
    );
    if (exact.rows.length === 1) return { id: exact.rows[0].id, name: exact.rows[0].name };
    // 别名精确命中（M55）：如「prop-v2」这类稳定短名，团队内唯一
    const alias = await client.query<{ id: string; name: string }>(
      `SELECT a.id, a.name FROM asset_aliases al
         JOIN assets a ON a.team_id = al.team_id AND a.id = al.asset_id
        WHERE al.team_id = $1 AND al.alias = $2 LIMIT 2`,
      [teamId, name.toLowerCase()]
    );
    if (alias.rows.length === 1) return { id: alias.rows[0].id, name: alias.rows[0].name };
    const like = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM assets WHERE team_id = $1 AND name ILIKE $2 ESCAPE '\\' ORDER BY name LIMIT 6`,
      [teamId, likeContains(name)]
    );
    if (like.rows.length === 1) return { id: like.rows[0].id, name: like.rows[0].name };
    if (like.rows.length === 0) throw new Error(`${side}.name「${name}」未命中任何本团队资产（名称或别名）`);
    throw new Error(
      `${side}.name「${name}」命中多个资产，请改用 assetId：` +
        like.rows.map((r) => `${r.name}(${r.id.slice(0, 8)}…)`).join("、")
    );
  }
  throw new Error(`${side} 须提供 assetId 或 name`);
}

/** 集合端点解析（collection.add 用）：UUID 按 id，否则团队内名称精确匹配；
 *  多命中列出候选要求改用 id。租户内解析（RLS 上下文由调用方事务决定）。 */
async function resolveCollectionRef(
  client: PoolClient,
  teamId: string,
  ref: unknown
): Promise<{ id: string; name: string }> {
  const key = String(ref ?? "").trim();
  if (!key) throw new Error("collection 不能为空（传集合名或 id）");
  if (/^[0-9a-f-]{36}$/.test(key)) {
    const { rows } = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM asset_collections WHERE team_id = $1 AND id = $2`,
      [teamId, key]
    );
    if (!rows[0]) throw new Error(`集合 id「${key}」不存在于本团队`);
    return rows[0];
  }
  const exact = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM asset_collections WHERE team_id = $1 AND name = $2 LIMIT 2`,
    [teamId, key]
  );
  if (exact.rows.length === 1) return exact.rows[0];
  if (exact.rows.length === 0) throw new Error(`集合「${key}」不存在（可先用 collection.search 查看现有集合）`);
  throw new Error(
    `集合名「${key}」命中多个集合，请改用 id：` +
      exact.rows.map((r) => `${r.name}(${r.id.slice(0, 8)}…)`).join("、")
  );
}

export const DRAFT_TOOLS: ToolDef[] = [
  {
    name: "issue.create",
    tier: "draft",
    description: "在本项目创建 Issue（日常协作，不需要审批）。必须给出标题与说明。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        assetId: { type: "string", description: "相关资产（可选）" },
        reportedRevisionId: { type: "string", description: "针对的修订（可选，须与 assetId 匹配）" },
      },
      required: ["title", "body"],
    },
    async execute(client, ctx, args) {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO issues (team_id, id, project_id, asset_id, reported_revision_id, title, body, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [ctx.teamId, id, ctx.projectId,
         args.assetId ? String(args.assetId) : null,
         args.reportedRevisionId ? String(args.reportedRevisionId) : null,
         String(args.title).slice(0, 200), String(args.body).slice(0, 16000), ctx.userId]
      );
      return { issueId: id };
    },
  },
  {
    name: "collection.add",
    tier: "draft",
    description:
      "把资产加入集合（人工策展，日常协作）。集合传名称（精确匹配）或 id，可先用 collection.search 查看现有集合；" +
      "资产传 assetId、名称或别名。可附 note 说明收录理由（如「作为权威起点」）。资产已在集合中会如实报错。",
    parameters: {
      type: "object",
      properties: {
        collection: { type: "string", description: "集合名称或 id" },
        assetId: { type: "string", description: "资产 id（与 assetName 二选一）" },
        assetName: { type: "string", description: "资产名称或别名（与 assetId 二选一）" },
        note: { type: "string", description: "收录理由备注（可选，≤500 字）" },
      },
      required: ["collection"],
    },
    async execute(client, ctx, args) {
      const collection = await resolveCollectionRef(client, ctx.teamId, args.collection);
      const asset = await resolveAssetRef(client, ctx.teamId, { assetId: args.assetId, name: args.assetName }, "asset");
      const note = String(args.note ?? "").trim().slice(0, 500);
      try {
        await client.query(
          `INSERT INTO asset_collection_items (team_id, collection_id, asset_id, note, added_by)
           VALUES ($1,$2,$3,$4,$5)`,
          [ctx.teamId, collection.id, asset.id, note, ctx.userId]
        );
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          throw new Error(`资产「${asset.name}」已在集合「${collection.name}」中`);
        }
        throw err;
      }
      return { collectionId: collection.id, collectionName: collection.name, assetId: asset.id, assetName: asset.name, note };
    },
  },
  {
    name: "external.notify",
    tier: "draft",
    description: "向外部系统发送通知（演示型外部副作用工具）。正常返回送达回执。",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string" },
        failMode: { type: "string", enum: ["none", "timeout_after_effect"], description: "测试注入：副作用后超时" },
      },
      required: ["message"],
    },
    async execute(client, ctx, args) {
      // 真实副作用（先落库），随后可能结果未知
      const receiptId = crypto.randomUUID();
      await client.query(
        `INSERT INTO agent_proposals (team_id, id, run_id, project_id, kind, payload)
         VALUES ($1,$2,$3,$4,'issue_triage',$5)`,
        [ctx.teamId, receiptId, ctx.runId, ctx.projectId, JSON.stringify({ external: true, message: String(args.message).slice(0, 500) })]
      );
      if (args.failMode === "timeout_after_effect") {
        throw new UnknownOutcomeError("通知已写入外部队列，但回执超时未收到");
      }
      return { receipt: receiptId, delivered: true };
    },
  },
  {
    name: "proposal.create",
    tier: "draft",
    description: "提交资产整理提案（如建议登记的资产、类型、属性、建议关系）。提案只是候选，不产生正式资产，也不能触发发布。",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["asset_registration", "relation_suggestion"] },
        payload: { type: "object", description: "结构化提案内容" },
      },
      required: ["kind", "payload"],
    },
    async execute(client, ctx, args) {
      const id = crypto.randomUUID();
      const kind = String(args.kind);
      if (!["asset_registration", "relation_suggestion"].includes(kind)) {
        throw new Error("kind 必须是 asset_registration 或 relation_suggestion");
      }
      await client.query(
        `INSERT INTO agent_proposals (team_id, id, run_id, project_id, kind, payload)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [ctx.teamId, id, ctx.runId, ctx.projectId, kind, JSON.stringify(args.payload)]
      );
      return { proposalId: id, status: "pending", note: "提案待成员审查；不会自动成为正式资产" };
    },
  },
];

/** 永不注册给 Agent 的人类高权动作（D02 负例即针对这些名字的调用应被拒绝）。 */
export const HUMAN_ONLY_TOOL_NAMES = [
  "review-and-publish",
  "release.publish",
  "review_and_publish",
  "permission.grant",
  "ontology.approve",
  "export.sensitive",
  "plugin.enable",
];

export function allAgentTools(): ToolDef[] {
  return [...READONLY_TOOLS, ...DRAFT_TOOLS];
}

export function toolSpecs(tools: ToolDef[]): { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export interface InvokeResult {
  status: "ok" | "denied" | "error";
  result?: unknown;
  error?: string;
}

/** 网关执行：记录每次调用（含拒绝）。 */
export async function invokeTool(
  client: PoolClient,
  ctx: ToolContext,
  tools: ToolDef[],
  callId: string,
  name: string,
  rawArgs: string
): Promise<InvokeResult> {
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    args = { _raw: rawArgs };
  }

  const record = async (status: "ok" | "denied" | "error", result?: unknown, error = "") => {
    await client.query(
      `INSERT INTO tool_invocations (team_id, id, run_id, call_id, name, args, result, status, error)
       VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, $8)`,
      [ctx.teamId, ctx.runId, callId, name, JSON.stringify(args), result ? JSON.stringify(result) : null, status, error]
    );
    return { status, result, error };
  };

  // 高权动作名即使被模型调用也一律拒绝（D02）
  if (HUMAN_ONLY_TOOL_NAMES.includes(name)) {
    return record("denied", null, "该动作只能由人类管理员在界面执行，Agent 无权调用");
  }
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return record("denied", null, `工具 ${name} 不在本次运行允许清单内`);
  }
  // SAVEPOINT 隔离：工具内 SQL 失败（如非法 UUID 参数）会中止整个事务，
  // 若直接 record 会因事务已中止而连带失败、整轮运行被拖死（实测走查发现）。
  // 回滚到保存点后再如实记录 error，运行继续、模型拿到错误反馈可自行修正。
  await client.query("SAVEPOINT tool_exec");
  try {
    const result = await tool.execute(client, ctx, args);
    await client.query("RELEASE SAVEPOINT tool_exec");
    return record("ok", result);
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT tool_exec").catch(() => undefined);
    if (err instanceof UnknownOutcomeError) {
      // 副作用已发生但结果未知：先留审计记录，再抛给运行器进入 unknown_reconcile（D06），
      // 不作为普通工具错误回喂模型（模型不得据此盲目重试）。
      await record("error", null, `外部执行结果未知：${err.message}`);
      throw err;
    }
    return record("error", null, err instanceof Error ? err.message : String(err));
  }
}

export function proposalDigest(payload: unknown): string {
  return canonicalDigest(payload);
}
