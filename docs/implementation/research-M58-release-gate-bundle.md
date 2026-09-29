# Research M58 — 发布测试门禁与批量关联下载（2026-09-29）

本目标点名的两个缺口：①「入库需要符合 schema 标准，包括部分模型需要过测试才可以通过」②「可以批量关联下载」。
schema 标准入库自 M2/A03 已落地（登记与修订提案均按类型链 JSON Schema 全量校验，本文件不重复调研）。
本轮聚焦两个新能力的业界锚点。

## 一、发布前测试门禁 —— GitHub Required Status Checks

来源：GitHub Docs「About protected branches / Troubleshooting required status checks」
（docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches）。

要点与吸收：

1. **策略声明在仓库（类型）层，不在 PR 层**：branch protection 声明哪些 check 必需，PR 自身无法豁免。
   → 吸收：`requires_test_evidence` 挂在 `asset_type_versions`（类型定义版本）上——"部分模型需要过测试"
   即"部分类型声明了门禁"。类型定义不可变，改门禁 = 注册新版本（与 schema 演进同构）。
2. **必需 check 未运行 = 永久 Pending = 阻断**：被 paths/branches 过滤跳过的必需 job 停在 Expected，
   合并被持续阻断；修复方式是让必需 job 总是汇报，而不是放宽合并。
   → 吸收：门禁类型的候选修订若从无测试运行，发布一律 422（不是警告）。
3. **Strict 模式要求分支最新**：过时分支即使曾经绿也阻断。
   → 吸收：门禁看"该精确修订（content_digest 绑定）的**最新一次**运行"——prepare 之后新落一条
   fail，即使之前有 pass，也按 fail 处理（test_runs.target_content_digest 证据只对该摘要有效，
   M3 设计原话）。评审快照把门禁状态折叠进 review_digest，prepare 后状态变化 → REVIEW_DIGEST_CHANGED，
   与 B04「内容或相关条件变化使批准失效」同机制，不另造第二条失效路径。
4. **开 PR 不阻断、合并在终点阻断**：required checks 卡的是 merge，不是 PR 创建。
   → 吸收：CR 创建/提案不卡门禁；卡 review-and-publish（+ prepare-review 如实展示），让作者先看见。

## 二、批量关联下载 —— HF snapshot_download + BagIt/Frictionless 打包

来源：huggingface_hub snapshot_download（HF 官方批量方式：整仓快照、allow_patterns 过滤、
无官方 zip 端点，批量=客户端多请求聚合）；BagIt（RFC 8493 精神：payload + 逐文件校验和清单
manifest-sha256.txt）；Frictionless Data Package（单一 datapackage.json 自描述描述符：资源、
schema、完整性哈希）；MIT Press 2022《Evaluation of Application Possibilities for Packaging》
对比两者并指出常配合使用。

要点与吸收：

1. **HF 的批量是"解析后再取"**：snapshot_download 本质是列清单→逐文件下载→本地聚合。
   自托管服务端做得到更好：一次 HTTP 请求，服务端解析关系闭包，直接流式返回 ZIP——远程可下载、
   天然离线移交（我们的部署形态是自管服务器，不受 HF 仓库形态约束）。
2. **关联闭包作为批量范围**：检索负责发现、关系负责结构（M54 结论），批量下载的范围=
   起点资产 + confirmed 关系 N 跳闭包（默认 1 跳、上限 3 跳、防环），每资产取当前头修订。
   另一条批量来源是 M56 集合：策展清单本身就是批量包（flat，不扩散闭包——策展即范围）。
3. **manifest 双层**（BagIt + Frictionless 配合使用）：
   - `manifest.json`（Frictionless 风格自描述）：来源与参数（起点/深度/方向或集合）、资产条目
     （id/名称/类型/修订/内容摘要/属性/别名/制品列表）、confirmed 关系边、防环截断等警告。
   - `manifest-sha256.txt`（BagIt 风格逐文件校验和）：`<sha256>  <path>`，覆盖全部 payload 文件，
     不含自身。接收方离线可核完整性——与 BlobStore 内容寻址同源（digest 即 sha256）。
4. **ZIP 采用 store（不压缩）+ 自研写入库**：项目依赖纪律是固定版本、少依赖；store-only ZIP
   ~150 行（CRC32 + 本地文件头 + 中央目录），确定性输出（同输入同字节），且测试侧无需解压
   库即可解析校验。模型/数据制品多为已压缩格式，store 无实际损失。
5. **文件名安全**：路径由服务端生成 `assets/<typeKey>/<安全化名称>/<制品原名>`，原名去路径分隔符、
   同目录重名追加序号——用户文件名不直接作为存储路径（目标正文第 3 节既有约束的 ZIP 内版）。
6. **使用度埋点复用**：bundle 内每资产计一次 kind=download（M55 usage_events 白名单既有值），
   热度分项自然聚合"被批量取走"。

## 三、结论

- 门禁 = 类型声明 + 证据绑定精确修订 + 最新运行为准 + 发布终点阻断 + 快照摘要折叠。
- 批量 = 服务端关系闭包/集合解析 + 一次请求 ZIP + 双 manifest + store 写死 + 埋点复用。
- 两者共同点：把"人审"前的机器证据变成硬约束（GitHub 思想），把"复用"的下载数据完整性
  变成离线可核（BagIt 思想）。
