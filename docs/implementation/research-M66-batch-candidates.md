# M66 调研笔记：批量候选轮（四项）

日期：2026-09-30 · 一次完成台账四个候选（用户点名批量）

## ① 草稿修订制品继承语义（M65 发现的丢制品脚枪）

- **问题**：POST /branches/:id/revisions 的 artifacts 字段 `.default([])`——只改
  属性的草稿（未选文件）会生成一个**没有制品行**的新修订，成为 head 后发布即丢
  制品。M65 实测坐实（M63 CLI Manual r2 制品为空）。
- **锚点**：RFC 7386 JSON Merge Patch 语义——**缺省=保留，显式提供=替换**；
  git 提交同理（内容不提及即沿用）。「替换」语义必须显式表达，不能靠缺省值隐式
  发生。
- **决策**：artifacts 改 `.optional()`；**缺省（未提供该字段）→ 复制 head 制品
  行到新修订**（canonical digest 同步用继承后的清单）；**显式提供数组（含空
  数组）→ 整体替换**（保留「换文件」「显式清空」能力）。web DraftPanel 未选
  文件时**省略 artifacts 字段**（原来发 []，正是踩坑点）。contentDigest 参与方
  （arts 清单）随之变化——继承后同制品同属性 ⇒ 同摘要，幂等性更好。

## ② bundle tagmanifest（补 M63 记录的边界）

- **问题**：M63 校验边界——manifest.json 自身不在 checksum 清单里，描述符整体
  被替换无法靠包内证据发现。
- **锚点**：BagIt RFC 8493 的 **tag manifest**（tagmanifest-sha256.txt 列出全部
  tag 文件——含 manifest 类文件自身的摘要）正是这个问题的标准答案。
- **决策**：打包侧 bundles.ts 新增第三个条目 `tagmanifest-sha256.txt`
  （manifest.json 与 manifest-sha256.txt 两行，sha256sum 双空格格式，排序）；
  校验侧 verifyBundle **存在才校验**（旧包兼容：缺 tagmanifest → ok 并注记
  「manifest.json 完整性不在包内可证」）；有 tagmanifest 时逐 tag 文件核对，
  manifest.json 被改即抓获——M63 边界就此闭合。

## ③ 完整度目录汇总（列表分数列 + 低分优先排序）

- **问题**：M65 scorecard 只在详情页；治理者看不到团队资产整体水位、找不到
  最该补元数据的资产。
- **锚点**：Backstage TechInsights 的目录级 Scorecard 视图 + CKAN 数据集质量
  在列表呈现；排序=「把最需要治理的排前面」。
- **决策**：GET /assets/search 行级附 `completenessScore`（同一条
  computeCompleteness 单一定义——required 用类型链缓存（按 type_version_id
  loadTypeChain+schemaToFormSpec，团队类型数有限）；properties/别名数/标签数/
  分类数/制品数补进查询，计算后剥离 properties 再返回）。`sort=completeness`
  升序（低分优先）：SQL 无法按 JS 分数排序——候选集（≤200）内计算后 JS 排序
  再截断，边界如实（超 200 的团队按治理口径分批）。web 目录加「完整度」列
  （按档着色）+ 排序选项「完整度（低分优先）」。

## ④ 引用导出 BibTeX/Markdown（Zenodo 锚点）

- **问题**：引用只有自定义格式字符串（复制引用按钮），学术工具链（LaTeX/
  文献管理器）需要标准格式。
- **锚点**：Zenodo「Cite」框（BibTeX/DataCite/CSL 多格式导出）+ GitHub
  「Cite this repository」生成的 @misc BibTeX。
- **决策**：@taw/domain/cite——buildCitation 纯函数两格式：BibTeX `@misc`
  （key=taw_\<id前8位>，title=name（typeKey），author=owner 属性或团队名，
  year=登记年，howpublished=平台+完整 id+类型版本，note=别名；花括号转义）；
  Markdown（与 CopyRefBtn 规范引用同口径的粗体行）。端点
  GET /assets/:assetId/cite?teamId&format=bibtex|markdown → text/plain；
  详情页「BibTeX」按钮复制并计 copy_ref 使用热度（导出即使用）。

## 边界

- ①继承语义对既有调用方的影响：显式传 [] 的调用（m64 测试）保持清空；不传的
  （m59 测试）从「清空」变「继承」——行为变化正是本轮目的，受影响断言如实修正。
- ③排序在 ≤200 候选集内计算；更大的团队分批（lifecycle/type 筛选缩小候选集）。
- ④BibTeX key 取 id 前 8 位保证唯一；owner 缺失时用「TAW 团队资产」占位并如实
  在 howpublished 标注。

## 验收

- tests/m66 四组：①缺省继承/显式替换/显式清空/摘要参与（继承后摘要与 head 一致
  当且仅当属性无变化）；②路由产物含 tagmanifest 且校验通过/manifest.json 篡改
  被抓/无 tagmanifest 旧包 ok 且注记；③search 附分且与详情一致/sort=completeness
  升序；④两格式端点（BibTeX 字段齐全+转义/跨团队 404/复制计热度——端点只读，
  热度由 UI 上报）。
