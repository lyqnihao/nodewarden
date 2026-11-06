# 用 GitHub Actions 自动部署到 Cloudflare Workers

> 适用仓库：`lyqnihao/nodewarden`（NodeWarden v1.8.1，Bitwarden 兼容服务端）
> 工作流文件：`.github/workflows/deploy.yml` · 预置脚本：`scripts/ci-provision.mjs`
> 文档版本：v1.0.0（2026-11-06）

---

## 一、这套自动化解决了什么问题

NodeWarden 本身已经带 `wrangler.toml`，官方 README 推荐用 Cloudflare 的「Continue with GitHub」可视化部署。但纯命令行的 `wrangler deploy` 在**全新 Cloudflare 账号**上会失败，因为：

| 缺失项 | 后果 | 本方案的处理 |
|---|---|---|
| D1 的 `database_id` | 配置里只有 `database_name`，无法部署 | 每次 CI 自动查询/创建 `nodewarden-db` 并注入 ID |
| R2 桶 / KV 命名空间 | 首次部署时资源不存在 | 自动创建（R2 模式建桶，KV 模式建命名空间并注入 ID） |
| `JWT_SECRET` | 运行时提示缺失，无法注册 | 从 GitHub Secret 生成密钥文件，随版本一起上传 |
| Node 版本 | 低版本构建报 `ERR_REQUIRE_CYCLE_MODULE` | 读取仓库 `.node-version`（24.22.1）安装 |
| 未配置凭据就 push | 工作流红灯 | 前置检查，缺 Secrets 时**跳过部署**而不是报错 |

工作流程：

```
push 到 main / 手动触发
  → 检查 3 个 Secrets 是否齐全
  → npm ci（Node 版本取自 .node-version）
  → npm run build（生成 dist 前端资源）
  → wrangler whoami（校验 Token）
  → ci-provision.mjs：幂等创建 D1 / R2 或 KV，生成 wrangler.ci.toml
  → wrangler deploy（附带 --secrets-file 与 --keep-vars）
  → 清理临时文件，输出部署摘要
```

`wrangler.ci.toml` 是 CI 运行期间生成的临时文件（已加入 `.gitignore`），仓库内的原始 `wrangler.toml` / `wrangler.kv.toml` **不会被修改**，方便日后 `Sync fork` 同步上游。

---

## 二、开始前的风险提示（请先看）

- **会覆盖同名 Worker**：部署目标固定为 `nodewarden`，会发布该 Worker 的新生产版本。若账号里已有同名 Worker，请确认它是本项目的实例。
- **数据不会丢**：D1、R2/KV 中的密码库数据在重新部署后保留；但**删除 Worker 也不会自动删除这些数据**。
- **`JWT_SECRET` 不能丢、不要随意更换**：更换会让所有已登录设备与会话失效（密码库数据本身不受影响）。请把它保存在密码管理器里。
- **R2 需要绑卡**：Cloudflare R2 免费额度需绑定支付方式才能开通。不想绑卡请用 **KV 模式**（免绑卡，但单个附件/Send 上限 25 MiB、总免费额度 1 GB）。
- **不要同时启用 Cloudflare 官方 Git 集成**：如果之前在 Cloudflare 里用「Continue with GitHub」建过 Workers Builds 项目，请停用它的自动部署，避免和 GitHub Actions 双份部署互相覆盖。
- **改 `.md` 文档不会触发部署**：工作流配置了 `paths-ignore: **/*.md`，这是有意为之。

---

## 三、分步部署

### 第 1 步：获取 Cloudflare Account ID

1. 打开 <https://dash.cloudflare.com/?to=/:account/workers-and-pages>，登录你的 Cloudflare 账号。
2. 在页面右侧栏找到 **Account ID**（32 位十六进制字符串），复制保存。
3. 备用方式：任意域名的「概述」页右下角也能看到；或本地执行 `npx wrangler whoami`。

### 第 2 步：创建 API Token（最关键的一步）

1. 打开 <https://dash.cloudflare.com/profile/api-tokens> → **Create Token** → 选择 **Create Custom Token**（自定义）。
   > 也可以先用「Edit Cloudflare Workers」模板，但务必确认它包含 D1 / R2 / KV 的 **Edit** 权限；模板权限不足是首次部署失败的最常见原因。
2. 按下表添加权限（Permissions）：

   | 权限 | 级别 | 用途 | 是否必需 |
   |---|---|---|---|
   | Account → **D1** | Edit | 创建/查询 `nodewarden-db` | 必需 |
   | Account → **Workers Scripts** | Edit | 部署 Worker、写入 Secrets | 必需 |
   | Account → **Workers R2 Storage** | Edit | 创建 `nodewarden-attachments` 桶 | R2 模式必需 |
   | Account → **Workers KV Storage** | Edit | 创建 KV 命名空间 | KV 模式必需（建议一并加上） |
   | Account → **Account Settings** | Read | `wrangler whoami` 校验 | 建议 |
   | Zone → **Workers Routes** | Edit | 绑定自定义域名时才需要 | 可选 |

3. **Account Resources**：`Include` → 只选你要部署的那个账号（最小权限）。
4. **Zone Resources**：保持默认即可（本工作流不操作 DNS/路由）。
5. 设置 TTL（可选，建议选一个到期时间），点 **Continue to summary** → **Create Token**。
6. **立即复制 Token**，它只显示一次。

### 第 3 步：生成 JWT_SECRET

在终端执行（任选一条）：

```bash
openssl rand -base64 48
# 或
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64'))"
```

要求：至少 **32 个字符**、随机、只生成一次后妥善保存。工作流会校验长度，不足 32 会直接失败。**不要把它提交到仓库或写进 `wrangler.toml`。**

### 第 4 步：在 GitHub 配置 Secrets

进入 `https://github.com/lyqnihao/nodewarden/settings/secrets/actions` → **New repository secret**，依次添加 3 个：

| Name | Secret 值 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 第 2 步复制的 Token |
| `CLOUDFLARE_ACCOUNT_ID` | 第 1 步的 Account ID |
| `JWT_SECRET` | 第 3 步生成的随机串 |

**（可选）选择 KV 模式**：切到同页面的 **Variables** 标签 → **New repository variable**，添加
`STORAGE_MODE` = `kv`。不添加则默认 `r2`。也可以在第 5 步手动触发时临时选择 `kv`。

> 注意：`JWT_SECRET` 必须是 **Actions Secrets**，不是 Cloudflare 里的 Build variables。本工作流会在部署时通过 `--secrets-file` 把它作为 Worker 的运行时 Secret 上传。

### 第 5 步：触发首次部署

1. 打开 `https://github.com/lyqnihao/nodewarden/actions`，选择左侧 **Deploy to Cloudflare Workers**。
2. 点 **Run workflow** → 选择分支 `main`、存储模式（`r2` 或 `kv`）→ **Run workflow**。
3. 展开运行日志，确认依次出现：
   - `ready=true`（Secrets 齐全）
   - `npm run build` 成功、`wrangler whoami` 显示你的账号
   - `[provision] D1 ... -> <uuid>` / `R2 桶 ... 已存在或已创建`
   - `Deployed nodewarden` / `Deployment complete`
4. 首次成功后，之后每次 `push` 到 `main` 都会自动部署（改 `.md` 除外）。

### 第 6 步：验证并开始使用

1. 打开 <https://dash.cloudflare.com/?to=/:account/workers-and-pages>，进入 `nodewarden`，复制 `*.workers.dev` 地址。
2. 浏览器打开该地址，应看到 NodeWarden 的注册/登录页；注册第一个账号（该账号即管理员）。
3. 在 Bitwarden 客户端（浏览器扩展 / 桌面 / 手机）里把「自托管环境 / 服务器 URL」填成这个地址即可登录同步。
4. 如需自定义域名：在该 Worker 的 **Settings → Domains & Routes** 添加（域名需已托管在 Cloudflare）。
5. 如需隐藏网页版密码库：在 Worker 的 **Settings → Variables and Secrets** 添加文本变量 `HIDE_WEB_VAULT = 1`。本工作流使用了 `--keep-vars`，重新部署**不会**清掉你手动添加的变量。

---

## 四、日常维护

| 场景 | 操作 |
|---|---|
| 同步上游更新 | GitHub 仓库页 → **Sync fork** → **Update branch**；合并后自动触发部署 |
| 手动重跑部署 | Actions 页 → 选最近一次运行 → **Re-run all jobs**，或用 **Run workflow** |
| 轮换 `JWT_SECRET` | 更新 GitHub 里的 `JWT_SECRET` Secret，再手动触发一次部署（所有设备需重新登录） |
| 从 R2 切到 KV | 设置仓库变量 `STORAGE_MODE=kv` 后手动触发；旧 R2 数据不会自动迁移 |
| 查看部署地址 | Actions 运行的 **Summary** 页，或 Cloudflare 控制台 |

---

## 五、常见问题排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 工作流显示成功但「构建并部署」被跳过 | 3 个 Secrets 未配齐，`precheck` 输出 `ready=false` | 补齐后用 **Run workflow** 手动触发 |
| `403` / `Authentication error` | Token 权限不足、账号选错、Token 过期 | 按第 2 步补齐权限；核对 `CLOUDFLARE_ACCOUNT_ID` |
| 创建 R2 桶失败，提示账号未开通 | R2 需绑定支付方式 | 设 `STORAGE_MODE=kv` 后重跑 |
| 部署后页面提示缺少 `JWT_SECRET` | 长度不足 32、或误配成 Build variables | 确认 GitHub Secrets 中的值，重新部署 |
| `ERR_REQUIRE_CYCLE_MODULE` / 构建失败 | Node 版本过低 | 工作流已按 `.node-version` 安装 24.22.1；本地请自行升级 |
| 重新部署后自定义变量被清空 | `wrangler deploy` 默认会清除 vars | 本工作流已加 `--keep-vars`；若手动部署请也加此参数 |
| 每次 push 部署两次 | 同时启用了 Cloudflare Git 集成 | 停用 Cloudflare 侧的自动部署 |
| `Sync fork` 提示冲突 | 上游改动了 `.gitignore` | 本方案只新增 3 个文件、`.gitignore` 追加 3 行，冲突概率低；按提示保留双方改动即可 |

---

## 六、版本历史

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0.0 | 2026-11-06 | 初始版本：新增 `deploy.yml` 自动部署工作流、`ci-provision.mjs` 资源预置脚本、本部署文档；`.gitignore` 忽略 CI 临时文件 |
