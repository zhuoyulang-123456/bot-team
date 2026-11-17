# 模型计费说明（给 Mac 版 Agent）

> 核对日期：2026-11-17。所有价格单位都是 **人民币元 / 百万 tokens**（美元价按 1 USD ≈ ¥7.2 折算，可用 `BT_USD_CNY` 覆盖）。
> 本文只写"官方价目表怎么写的""代码里现在怎么算"，不写任何个人账号、项目或会话信息。

---

## 一、先看结论：为什么"用户看到 4 块，控制台才 5 毛"

Windows 版排查后发现，偏差不是单点 bug，而是 5 个问题叠加。Mac 版大概率同样存在（代码是同一份），建议逐条对照修复。

### 1. 缓存命中被按全价重复计费（影响最大）

OpenAI 风格接口返回的 `usage.prompt_tokens` **已经包含**缓存命中的部分，同时另有 `prompt_tokens_details.cached_tokens`。

旧代码：

```js
inputBillable = input - (event.cacheIncluded ? cacheRead : 0)
```

而 `normalizeBackendUsage()` 对 OpenAI 风格只在 `cache_read_input_tokens === 0 && cached_tokens > 0` 时才把 `cacheIncluded` 置为 true。DeepSeek 返回的是 `prompt_cache_hit_tokens` / `prompt_tokens_details.cached_tokens`，落到 `cacheIncluded = false`，于是：

- 全部输入按未命中价算一遍
- 缓存命中部分再按缓存价算一遍

实测样本：`input 53902`，其中 `cached 51840` → 旧算法 ¥0.25，正确算法 ¥0.0616（差 4 倍）。

**修复**：`lib/usage.mjs` 的 `estimate()` 里改为直接按 `event.cacheIncluded` 扣减；`recordUsage()` 与 `lib/history.mjs` 都补写 `cacheIncluded` 字段。

### 2. `自定义 API` 后端一律按"国产模型通用价"估

`priceForModel()` 只认模型名里的厂商前缀。用户用「自定义 API + `deepseek-flash`」时，既没有 `deepseek/` 前缀，也拿不到官方价，最后落到 `staticPrice()` 的兜底价（输入 2 / 输出 8 / 缓存 0.2）。

**修复**：新增 `setCustomPrices()` / `customPriceFor()`，并在设置里加「自定义 API 单价」编辑区（按模型名填输入 / 输出 / 缓存价）。`priceForModel()` 的查找顺序改为：

```
免费模型 → 用户自定义单价 → DeepSeek 官方人民币价 → models.dev 缓存 → 静态价格表
```

### 3. 订阅渠道的消耗被排除在"合计"之外

`estimate()` 里：

```js
cost: isSub ? (includeSubscription ? creditBase : 0) : apiCost
```

而 `includeSubscription` 默认 `false`，前端开关默认也是关的。结果：WorkBuddy / Qoder / Codex 这些订阅渠道的消耗**永远不计入合计**，看起来"几乎没花钱"。

**修复**：

- `summarizeUsage()` / `usageDetail()` 的 `includeSubscription` 默认改为 `true`
- HTTP 层改为 `q.get('includeSubscription') !== '0'`（缺省即计入）
- 前端 `S.usageSub` 默认 `true`，`localStorage` 只有显式存 `'0'` 才算关闭

### 4. WorkBuddy 的积分是"猜"的

旧代码写死 `31,874 tokens = 1 积分`，而 CodeBuddy CLI 实际会在 `system/usage_update` 与 `result` 事件里返回 `_meta["codebuddy.ai/turnUsage"].total.credits`。

**修复**：

- `runCodebuddy()` 解析 `turnUsage.total.usage` 与 `turnUsage.total.credits`，作为 `res.credits` 返回
- `DEFAULT_CREDIT_PLANS.codebuddy.tokensPerCredit` 默认改为 `0`（= 不估算）
- `creditsForRun()` 在拿不到真实积分且没配换算比例时返回 `null`，让调用方回落到 token 单价，而不是记 0 元

### 5. 价格表匹配 bug 与订阅标记

- `FALLBACK` 里 `/gpt-6\\.1-sol/` 这种写法在 JS 正则字面量里等价于 `/gpt-6\.1-sol/` 的**字面反斜杠**，实际匹配不到 `gpt-6.1-sol`，全部落到高价兜底
- `glm-5.3-flashx` 被 `glm-5.3-flash` 抢先匹配
- `orchestrator.mjs` 里 `creditsEstimated` 用 `||` 累加，一次估算就把整轮标记成"估算"，即使后面拿到了真实积分

---

## 二、官方价目表（2026-11-17 核对）

### DeepSeek（官方人民币价，峰谷计费）

| 模型 | 缓存命中 | 输入（未命中） | 输出 |
| --- | --- | --- | --- |
| `deepseek-flash`（= V4.1-Flash） | 0.04（闲 0.02） | 2（闲 1） | 8（闲 4） |
| `deepseek-v4-pro` | 0.30（闲 0.15） | 9（闲 4.5） | 27（闲 13.5） |

高峰：北京时间周一至周五 9:00–12:00、14:00–18:00（不含法定节假日）；其余时间（含周末、节假日全天）为空闲，空闲价 = 高峰价 ÷ 2。判定依据是**服务端收到请求的时间**。

### OpenAI（美元，× 7.2）

| 模型 | 输入 | 缓存输入 | 输出 |
| --- | --- | --- | --- |
| gpt-6.1-sol | 2.00 | 0.10 | 10.00 |
| gpt-6.1-terra | 1.00 | 0.05 | 5.00 |
| gpt-6-astra | 10.00 | 1.00 | 50.00 |
| gpt-6-luna | 0.10 | 0.01 | 0.50 |
| gpt-6-sol | 2.00 | 0.20 | 10.00 |
| gpt-5.6-sol | 4.00 | 0.40 | 20.00 |
| gpt-5.6-terra | 2.00 | 0.20 | 12.00 |
| gpt-5.6-luna | 0.20 | 0.02 | 1.20 |
| gpt-5.3-codex | 1.75 | 0.175 | 14.00 |

> 上下文 > 272K 时输入 ×2、输出 ×1.5；Batch 五折；Codex 走 ChatGPT 订阅时不收缓存写入费。

### Anthropic（美元，× 7.2）

| 模型 | 输入 | 缓存读 | 缓存写（5m / 1h） | 输出 |
| --- | --- | --- | --- | --- |
| Claude Fable 5.2 / Mythos 5.2 | 8.00 | 0.20 | 10 / 16 | 40.00 |
| Claude Opus 5.5 | 4.00 | 0.20 | 5 / 8 | 20.00 |
| Claude Opus 5 / 4.8 / 4.7 / 4.6 | 5.00 | 0.50 | 6.25 / 10 | 25.00 |
| Claude Sonnet 5.5 | 2.00 | 0.10 | 2.50 / 4 | 10.00 |
| Claude Sonnet 5 | 2.00 | 0.20 | 2.50 / 4 | 10.00 |
| Claude Sonnet 4.6 / 4.5 | 3.00 | 0.30 | 3.75 / 6 | 15.00 |
| Claude Haiku 5.5（≤100K） | 0.10 | 0.01 | 0.125 / 0.20 | 0.50 |
| Claude Haiku 5.5（>100K） | 0.50 | 0.05 | 0.625 / 1 | 2.50 |
| Claude Haiku 4.5 | 1.00 | 0.10 | 1.25 / 2 | 5.00 |

> Haiku 5.5 按**单次请求**的 prompt 长度分档，超过 100K 整单涨价（缓存读也算进阈值）。

### Google（美元，× 7.2）

| 模型 | 输入 | 缓存 | 输出 | 备注 |
| --- | --- | --- | --- | --- |
| gemini-4-carbon / gemini-4-argon | 2.00 | 0.10 | 10.00 | 2026-12-01 起 4 / 0.20 / 20 |
| gemini-4-hydrogen | 1.50 | 0.075 | 7.50 | |
| gemini-3.8-flash | 0.75 | 0.075 | 3.75 | 2027-01-01 起翻倍 |

### 智谱（官方人民币价）

| 模型 | 输入 | 缓存命中 | 输出 |
| --- | --- | --- | --- |
| GLM-5.3 | 8 | 2 | 28 |
| GLM-5.3-Flash | 0.8 | 0.23 | 2.8 |
| GLM-5.3-FlashX | 2 | 0.57 | 7 |

### 月之暗面（官方人民币价）

| 模型 | 缓存命中 | 输入 | 输出 |
| --- | --- | --- | --- |
| kimi-k3 | 2 | 20 | 100 |
| kimi-k3.1-pro | 2.2 | 22 | 110 |
| kimi-k2.7-code | 1.3 | 6.5 | 27 |
| kimi-k2.7-code-highspeed | 2.6 | 13 | 54 |
| kimi-k2.6 | 1.1 | 6.5 | 27 |

> K3 系列缓存写入按 TTL 单独计费（5min / 1h），命中后不再收写入费。

### MiniMax（官方人民币价）

| 模型 | 输入 | 缓存读取 | 输出 |
| --- | --- | --- | --- |
| MiniMax-M3.1-Flash | 1.00 | 0.10 | 4.00 |
| MiniMax-M3（≤512K） | 2.10 | 0.42 | 8.40 |
| MiniMax-M3（>512K） | 4.20 | 0.84 | 16.80 |

### 阿里云百炼（官方人民币价，北京地域）

| 模型 | 输入 | 缓存命中 | 输出 |
| --- | --- | --- | --- |
| qwen4-max | 10.2 | 0.51 | 30.5 |
| qwen3.8-max | 11.9 | 0.6 | 35.7 |
| qwen3-coder-flash（≤32K） | 1.04 | — | 4.13 |

> 百炼部分模型按单次请求输入长度阶梯计费，长上下文会跳档。

### 小米 MiMo（官方人民币价）

| 模型 | 缓存命中 | 输入 | 输出 |
| --- | --- | --- | --- |
| mimo-v2.6-pro | 0.025 | 3.00 | 6.00 |
| mimo-v2.6-flash | 0.02 | 1.00 | 2.00 |

### 腾讯混元 TokenHub（官方人民币价）

| 模型 | 输入 | 缓存命中 | 输出 |
| --- | --- | --- | --- |
| Hy4 Flash | 0.5 | 0.02 | 2 |
| Hy4 | 6 | 0.3 | 18 |
| Hy3 | 1 | 0.25 | 4 |

> Hy4 Flash 至 2026-11-30 12:00 按目录价 50% 结算；Hy4 至 2026-12-31 23:59 按 50% 结算。

### Mistral（美元，× 7.2）

| 模型 | 输入 | 缓存输入 | 输出 |
| --- | --- | --- | --- |
| Mistral Large 4 | 0.70 | 0.07 | 2.10 |
| Mistral Medium 3.5（Vibe 默认） | 1.50 | 0.15 | 7.50 |
| Mistral Small 4 | 0.15 | 0.015 | 0.60 |
| Codestral | 0.30 | 0.03 | 0.90 |

---

## 三、订阅 / 积分渠道怎么折算

这些渠道**不是按 token 计价**，而是订阅额度。面板里应该显示"积分 / 额度"，再按套餐单价折算成钱，并且要标明是估算。

| 渠道 | 官方计费单位 | 官方价格 | 折算建议 |
| --- | --- | --- | --- |
| WorkBuddy / CodeBuddy | Credits（与 CodeBuddy 同账号共享） | 标准版 99 元/月 4,000 积分；高级版 199 元/月 9,000；旗舰版 999 元/月 50,000；加量包 50 元 / 1,000 积分 | 按用户实际套餐算单价：约 0.02–0.05 元/积分 |
| Qoder CN | Credits | Pro 59 元/月 2,000；Pro+ 169 元/月 6,000；Ultra 559 元/月 20,000；资源包 40 元 / 1,000 | 约 0.028–0.03 元/Credit（资源包 0.04） |
| OpenCode Go | 美元用量额度 | Go $10/月、Go Plus $40/月、Go Teams $20/人/月 | 按各模型美元额度折算，不要用 token 单价 |
| MiniMax M Plan | Token 窗口额度 | Go ¥49/月、Explore ¥119、Build ¥469 | 按套餐档位折算 |
| Mistral Vibe Pro | 订阅 | $14.99/月（含 $30 API 额度） | 按订阅折算 |
| Qwen Code | Coding Plan | $50/月（6,000 次请求 / 5 小时） | 按请求数折算 |
| ChatGPT Plus / Codex | 订阅 | 按用户套餐 | 只显示"订阅内"，不折钱 |

**关键点**：WorkBuddy 的 CLI 现在会返回真实积分（`turnUsage.total.credits`），能用真实值就别估算；`tokensPerCredit` 默认应为 0（不估算），让用户自己按套餐填。

> 注意：WorkBuddy 的积分消耗还有"模型倍率"（客户端模型面板里显示 x0.06、x0.16、x0.29 等），同一份 token 用不同模型扣的积分差很多，所以**不要**用 token 数反推积分。

---

## 四、Mac 版建议的改动清单

1. `lib/usage.mjs`
   - `estimate()`：按 `cacheIncluded` 扣减缓存；`creditBilled` 要求 `creditCost > 0`；`cost` 默认计入订阅；返回 `unpriced` 标记
   - `recordUsage()` / `summarizeUsage()` / `usageDetail()`：`includeSubscription` 默认 `true`
   - `recordUsage()` 写入 `cacheIncluded`
2. `lib/history.mjs`：事件里补 `cacheIncluded`
3. `lib/pricing.mjs`
   - 新增 `setCustomPrices()` / `customPriceFor()`，`priceForModel()` 优先查用户单价
   - `creditsForRun()`：拿不到真实积分且无换算比例时返回 `null`；免费模型返回 0
   - `DEFAULT_CREDIT_PLANS.codebuddy.tokensPerCredit` 改为 0
   - 按本文第二节重写 `FALLBACK`（注意正则不要写成 `/gpt-6\\.1/`）
4. `server.mjs`
   - `/api/settings` PATCH 支持 `modelPrices`
   - 启动时 `setCustomPrices(state.settings?.modelPrices)`
   - `includeSubscription` 解析改为 `!== '0'`
   - 积分单价保存时合并而不是覆盖另一个渠道
5. `public/app.js`
   - `S.usageSub` 默认 `true`
   - 设置页加「自定义 API 单价」编辑区
   - WorkBuddy 积分提示改为"CLI 会返回真实积分，老版本才需要填换算比例"
6. `lib/orchestrator.mjs`：`creditsEstimated` 用"有真实值就不算估算"的逻辑

---

## 五、验证方法

```bash
# 1) 价格表抽查
node -e "import('./lib/pricing.mjs').then(m=>['deepseek-flash','gpt-6.1-terra','glm-5.3-flashx','hy4-flash'].forEach(x=>console.log(x, m.priceForModel(x))))"

# 2) 用真实事件重算（不碰线上数据）
BOT_TEAM_HOME=/tmp/bt-usage-test node -e "…构造 usage-events.jsonl 后调 summarizeUsage…"
```

验收标准：

- 同一笔「10 万输入（其中 8 万缓存）+ 1 万输出」的 DeepSeek 调用，成本应为 ¥0.0616（高峰），不是 ¥0.25
- 订阅渠道的消耗出现在「合计估算」里，且「订阅折算」卡片有值
- WorkBuddy 一轮真实调用后，消息下方显示的是 CLI 返回的积分（不带"（估算）"）
- 未配置单价的未知模型，面板底部提示"有 N 次调用未命中价格表"

---

## 六、价格会变

以上数字都是 2026-11-17 从各厂商官方价目表核对的。以下这些是**已知会变**的：

- Gemini 4 Carbon / Argon：2026-12-01 起输入 2 → 4、输出 10 → 20
- Gemini 3.8 Flash：2027-01-01 起翻倍
- 混元 Hy4 / Hy4 Flash：限时 5 折，分别到 2026-12-31 / 2026-11-30
- Mistral Large 4：促销价，结束日期未公布
- DeepSeek：历史上调过两次价（V4-Pro 上线、V4.1-Flash 降价）

建议在 `pricingMeta()` 里带上 `verifiedAt` 字段，并在面板上显示"价格核对日期"，让用户知道什么时候该复核。
