# M53 调研笔记：开源资产管理/元数据项目设计吸收

> 2026-09-29 · 广泛调研 9 个同类开源项目，提炼可直接落地的设计点。
> 本轮（M53）已吸收项标注 ✅；其余列为后续候选（见 HANDOFF）。

## 一、调研对象与关键启发

| 项目 | 关键设计点 | 对本系统的启发 |
| --- | --- | --- |
| LinkedIn DataHub | Tags（松管控）与 Glossary（受控词汇）双轨；血缘与属性同图；MCP/工具层暴露元数据原语 | 标签 vs 分类/标签已是双轨；Agent 工具集已暴露图检索原语（M50） |
| OpenMetadata | JSON Schema 强类型 + extension 自定义属性可过滤聚合；LLM 辅助补描述 | 类型系统同构；自定义属性筛选为后续候选 |
| Apache Atlas | 类型—分类—关系三元模型；分类沿血缘传播；JanusGraph 影响分析 | 关系断言/类型闭包已落地；「废弃沿依赖传播」列为候选 |
| Netflix Metacat | 联邦元数据层：资产引用 locator 而非拷贝 | 制品存内容寻址 CAS，元数据层编目——架构一致 |
| NetBox | Custom Links 模板外链（Git/CI/文档一键跳转）；URL 化过滤器；Journaling 与 change log 分离 | 属性内 URL 直链已落地 ✅；URL 化筛选列候选 |
| Snipe-IT / GLPI | 状态机（在用/归档/弃用）+ 借还事件流 | 生命周期三态已有；事件流=审计与动态 |
| Amundsen | 搜索服务与图服务分离，搜索结果可引入被引次数信号 | PG 检索 + Memgraph 投影同构；排序信号列候选 |
| CKAN | Dataset–Resource 两层：资源直接预览/下载；分面（facet）筛选导航 | 制品随取随用 ✅ + 分面筛选 ✅（本轮落地） |
| OpenCTI | 图内过滤（类型/标签）、局部展开、类型着色图例 | 图例点选显隐 + 度数降噪 ✅（本轮落地） |

## 二、Top 8 吸收清单（调研产出）

1. ~~自定义链接模板（NetBox）~~ → ✅ 本轮以「属性值 URL 自动直链」形态部分落地（详情页属性含 http(s) 链接可点开）。
   备注：完整模板变量形态（如 `https://git.example.com/{properties.repo}`）列为候选。
2. Tag 与受控词汇分层（DataHub）→ 系统已有 labels（松）+ categories（受控路径）双轨，无需改动。
3. 分面筛选导航（CKAN）→ ✅ `GET /assets/facets`（在用类型/标签计数/分类路径）+ 目录家族快筛 chips。
4. Dataset–Resource 资源随取随用（CKAN）→ ✅ 详情页制品卡一键下载；`/blobs/:digest` 回真实文件名（RFC 5987）。
5. 局部展开式图谱（OpenCTI）→ ✅ 类型图例点选显隐（off 态保留可恢复）+ 度数降噪（保留枢纽）+ 边标签开关。
6. 资产状态机与领用事件流（Snipe-IT）→ 生命周期（进行中/归档/弃用）+ 审计事件已有；借还语义不适用本域。
7. 自定义属性进筛选器（OpenMetadata）→ 候选（需属性索引设计）。
8. 分类沿血缘传播（Atlas）→ 候选（关系断言带传播规则）。

## 三、本轮落地的对照表

| 调研启发 | M53 落地 |
| --- | --- |
| CKAN 分面 | `GET /assets/facets`；`/assets/search` 补 `label`（原参数声明未实现的真实缺口）与 `typePrefix`；目录家族快筛 chips（文档/代码/测试/仿真/数据前缀映射，纯函数 `typeFamilyOf`） |
| CKAN 资源随取随用 | 详情端点 revisions 携带 artifacts；详情页制品卡（角色/大小/下载）；`GET /blobs/:digest` 补 `content-disposition; filename*=UTF-8''…`（顺带修复该查询漏租户上下文被 RLS 静默拦截的真实缺陷） |
| NetBox 自定义链接 | 详情页属性渲染时 http(s) 值变可点链接（随取随用的另一面） |
| OpenCTI 图内过滤 | 图例=全量参与类型（可见/总数），点选显隐可恢复；度数降噪（度 ≥ N，剪边保留达标孤立枢纽）；边标签开关（localStorage 记忆） |
| DataHub/OpenMetadata Agent 惯例 | 流式 token 输出（SSE `message_delta`，300ms 合帧落库）+ 工具卡简约折叠/展开详情 + 耗时显示（自研差异化，调研确认各项目对 Agent UX 着墨少） |

## 四、来源

- DataHub: https://docs.datahub.com/docs/tags ；https://datahub.com/blog/data-lineage-best-practices
- OpenMetadata: https://docs.open-metadata.org ；https://blog.open-metadata.org
- Apache Atlas: https://atlas.apache.org
- Netflix Metacat: https://github.com/Netflix/metacat
- NetBox: https://netbox.readthedocs.io
- Snipe-IT: https://snipe-it.readme.io ；GLPI: https://www.glpi-project.org
- Amundsen: https://github.com/amundsen-io/amundsen
- CKAN: https://docs.ckan.org
- OpenCTI: https://docs.opencti.io/latest/usage/data-model
