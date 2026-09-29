# M63 调研笔记：Bundle 离线校验与回导工具

日期：2026-09-30 · 位置：`packages/domain/src/bundle-verify.ts` + `scripts/bundle-tools.ts`

## 问题

M58 产出批量关联下载：`GET /assets/:id/bundle` 一次性给出自描述 ZIP
（manifest.json + manifest-sha256.txt + 制品原文件）。但拿到包之后：

1. **离线无法证明包完好**——接收方（异地同事、归档、CI）只能相信下载过程没出错；
   校验和清单躺在包里却没有任何工具去核。
2. **包进不回来**——跨团队/灾备恢复/换环境时，包里的资产与关系没有再入库通道；
   只能人对着 manifest 手工重录。

## 调研：既有做法

- **BagIt（RFC 8493，M58 打包侧锚点的另一半）**：校验是 BagIt 的核心操作，且明确
  区分两个概念——**complete**（payload 文件与清单双向对应：清单里有的包里有、
  包里有的清单有）与 **valid**（每个文件的校验和算得对）。二者分开报告，
  `bag verify` 的输出口径即如此；`sha256sum -c manifest-sha256.txt` 是最朴素的
  valid 检查，complete 要靠工具补。
- **Frictionless Data Package**：descriptor（datapackage.json）+ 资源校验一体；
  `frictionless validate` 同时查 descriptor 结构与数据完整性。
- **内容寻址再入库（git/DVC/CAS 惯例）**：回导时 blob 按摘要去重——同内容已存在
  则上传近乎零成本，天然幂等；元数据（属性/关系）按目标注册表的规则重新过闸。
- **治理边界（本项目自己的原则）**：回导绝不能绕过目标环境的关卡——M59 schema
  强制、成员校验、RLS 都必须原样生效。因此回导工具定为**公开 API 的客户端**
  （登录/CSRF/上传/登记/建关系全走既有端点），不做任何直连数据库的后门。

## 决策

1. **读取器与写入器同源自建**：M58 手写了 store-only ZIP 写入（buildStoreZip），
   本轮补对称的 `readStoreZip`（EOCD → 中央目录 → 局部头切片，CRC32 复核，非
   store 条目如实拒绝），零解压库依赖，与写入器同一套格式假设。
2. **校验 = complete + valid + manifest 交叉核对**（BagIt 口径）：
   - complete：payload 文件 ↔ manifest-sha256.txt 双射（多出的文件、缺失的文件
     都报）；manifest.json / manifest-sha256.txt 自身不算 payload。
   - valid：逐文件 sha256 重算比对；坏行（非 64 位十六进制）如实报。
   - 交叉核对：manifest.json 里每个制品的 path/digest/size 与 zip 实物一致，
     `tawBundle: 1` 版本号核对——防「清单对但描述符被改」。
   - **边界如实**：manifest.json 自身不在 checksum 清单里（M58 格式如此），描述符
     整体被替换无法靠包内证据发现——交叉核对能抓制品级篡改，抓不到纯元数据改写；
   记为已知边界，未来可加 tagmanifest（BagIt tag 文件校验和）。
3. **回导走公开 API，先校验后导入**：`import` 命令先做完整离线校验，不过就拒绝
   导入；然后按 manifest 顺序——类型按 (typeKey, typeVersion) 精确解析（缺失即
   如实跳过，不悄悄映射到别的版本）→ 制品按摘要上传（/uploads 内容寻址去重，
   返回摘要与 manifest 不符即中止：完整性兜底）→ 资产登记（POST /assets，M59
   关卡可能拒绝，逐条记录原因）→ 关系重建（两端资产都成功且谓词类型存在才建，
   evidenceNote 注明回导来源）。
4. **不回导的如实列清单**：别名（团队唯一 slug，冲突需人工决策）、测试运行
   （证据绑定精确修订，跨环境无意义）、lifecycle 状态（新环境从「进行中」开始）
   ——报告里写明，不静默丢弃。
5. **`--dry-run`**：类型/关系类型解析 + 计划打印，零写入——先看清楚再动。

## 边界

- 回导不做事务回滚：逐条导入、逐条如实报告成败（部分成功是合法结果）；目标团队
  想要原子性可先 dry-run 确认。
- 关系谓词按 type_key 解析到目标团队**最新版本**（导出方记录的是当时的 type_key；
  若目标团队该 key 语义已演进，由 evidenceNote 里的来源信息人工复核）。
- ZIP64/加密/压缩条目不支持（本项目的包都是 store-only 小包，256MB 上限）。

## 验收

- tests/m63：读取器往返（buildStoreZip↔readStoreZip 字节一致）；校验 ok/篡改字节/
  缺文件/多文件/坏清单行/manifest 交叉核对；API 端到端（真实下载的包离线校验通过；
  回导到新团队含 dry-run、全量导入、类型缺失团队的部分导入如实报告）。
- 真实服务器 CLI 实测：演示团队造数据 → curl 下载包 → `verify` 通过 → `import`
  到新团队 → 输出与退出码正确，证据存 docs/evidence。
