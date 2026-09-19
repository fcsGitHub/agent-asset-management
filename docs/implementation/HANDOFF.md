# HANDOFF — 交接

更新时间：2026-09-20

## 仓库状态

- 路径：D:\project\agent-asset-management（Windows，Git Bash）
- 分支：main（本仓库为新建 git 仓库；此前无任何历史，无用户未提交修改可保护——初始内容仅 keys.txt 与两份设计/目标文档，均已保留）
- 注：keys.txt 含真实 API key，已加入 .gitignore，不入库。

## 已完成

- 完整读取两份基线文件；42 项验收入台账
- M0 全部（EV-001~007）+ M1 后端/前端/E2E（EV-008~010）
- M1 内容：登录会话（scrypt+服务端会话+CSRF）、团队/项目/Session、消息持久化、
  内容寻址文件库（去重、大小限制、同盘 rename）、七类类型定义+动态属性校验（ajv+词表）、
  不可变修订+关系断言、RLS（NULLIF 修复）、受限角色 taw_app、两区工作台 UI（含窄屏切换）
- 真实 DeepSeek API 冒烟通过（deepseek-flash）

## 未完成

- M2~M5 全部（分支/发布/项目闭环/Agent/语义/硬化）
- A01 归档动作、B01 API 层修订写入口（随 M2 分支 API 复核）
- 已知技术债：多团队用户的项目枚举逐团队循环查询（N+1，规模后优化）

## 风险

- Windows 宿主开发：目标设计以 Linux 服务端为主；开发期用 Docker 化 PG，部署/离线/ARM64 验证受限（E06 预计部分标记未验证）
- Pi/Semantica 上游 API 细节需按锁定版本写契约测试，不能凭名称猜方法

## 恢复入口

1. 读 docs/implementation/PLAN.md（当前下一步）
2. 读 docs/implementation/ACCEPTANCE.md + HANDOFF.md
3. `docker compose up -d postgres` → `npx tsx scripts/migrate.ts --role=admin`
4. 继续 PLAN.md"当前下一步"清单
