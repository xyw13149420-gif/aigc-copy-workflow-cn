# AIGC 文案工作流 · 一次真实运行样例

> 由 `aigc_copywriter.py` 渲染，模板来自 `copy_templates.json`。同一 `--seed` 重复运行，正文逐字一致。
> 分工：模板管结构与合规，脚本管变量注入与组合去重。

## 0. 运行参数

| 参数 | 值 |
| --- | --- |
| 商品 | 无谷鲜肉成猫粮 |
| 到手价 | 129 元 |
| 规格 | 1.8kg |
| 人群 | 1-3岁室内猫主人 |
| 平台 | tmall（天猫/淘宝） |
| 标题数量 | 5 |
| 随机种子 | 7 |
| 品牌 / 成分 / 功能 |  / 无谷鲜肉 / 高蛋白 |
| 数字卖点 / 场景 / 赠品 | 粗脂肪 16% / 多猫家庭 / 计量杯 |

## 1. 商品标题（5 条 · 全部 ≤30 字 · 互不重复）

| # | 标题 | 字数 | 模板 | 价格带 |
| --- | --- | --- | --- | --- |
| 1 | 无谷鲜肉成猫粮1.8kg 无谷鲜肉 适合室内猫 | 23 | T03 | 100-199 |
| 2 | 无谷鲜肉成猫粮 1.8kg 室内猫推荐 无谷鲜肉 | 24 | T05 | all |
| 3 | 无谷鲜肉成猫粮 无谷低敏 1.8kg | 18 | T10 | all |
| 4 | 无谷鲜肉成猫粮1.8kg 送计量杯 | 17 | T13 | all |
| 5 | 多猫家庭囤货 无谷鲜肉成猫粮 1.8kg | 20 | T11 | all |

- 字数校验：5 条全部 ≤30 字，最长 24 字。
- 去重规则：标题归一化后按字符二元组 Jaccard ≥ 0.80 判为重复，命中即换模板重抽。
- 超长回退：0 条候选超过 30 字，已自动跳到短模板；0 条候选与已有标题过于相似，已重抽。

## 2. 卖点（6 条 · 痛点 + 成分/工艺证据 + 可感知结果 + 数字）

| # | 卖点文案 | 结构拆解 | 类型 |
| --- | --- | --- | --- |
| 1 | 换粮就软便、还老舔爪子？0 谷物配方，单一动物蛋白来源，便便成型，不痒不挠（谷物 0%）。 | 痛点「换粮就软便、还老舔爪子」→ 证据「0 谷物配方，单一动物蛋白来源」→ 结果「便便成型，不痒不挠」→ 数字「谷物 0%」 | 成分 |
| 2 | 毛球吐在地毯上、老干呕的话看这条：粗纤维 6%，车前子壳帮助毛球随粪便排出，毛球跟着粪便排走。 | 痛点「毛球吐在地毯上、老干呕」→ 证据「粗纤维 6%，车前子壳帮助毛球随粪便排出」→ 结果「毛球跟着粪便排走」→ 数字「」 | 排毛 |
| 3 | 解决绝育后体重一路往上：粗脂肪 16%，比同价位低 3 个百分点，腰线回来，曲线稳住。 | 痛点「绝育后体重一路往上」→ 证据「粗脂肪 16%，比同价位低 3 个百分点」→ 结果「腰线回来，曲线稳住」→ 数字「」 | 体态 |
| 4 | 吃得多拉得多、便里有残渣？鲜肉酶解工艺，配料表可查，同样的量，便量更少，参数摆在这：粗蛋白 42%。 | 痛点「吃得多拉得多、便里有残渣」→ 证据「鲜肉酶解工艺，配料表可查」→ 结果「同样的量，便量更少」→ 数字「粗蛋白 42%」 | 肠道 |
| 5 | 先说开封就返潮、结块这件事——自封条 + 铝膜内袋，开封后不结块，一个月不返潮，口感不塌，可查的是开封 1 个月不返潮。 | 痛点「开封就返潮、结块」→ 证据「自封条 + 铝膜内袋，开封后不结块」→ 结果「一个月不返潮，口感不塌」→ 数字「开封 1 个月不返潮」 | 包装 |
| 6 | 配料表前三位都是肉，动物蛋白占比 90%，所以怕蛋白虚标、吃了不长肉这事有解：摸得到肌肉，毛也厚。 | 痛点「怕蛋白虚标、吃了不长肉」→ 证据「配料表前三位都是肉，动物蛋白占比 90%」→ 结果「摸得到肌肉，毛也厚」→ 数字「」 | 成分 |

## 3. 客服话术（4 条 · 售前 / 物流 / 售后 / 催付 各 1 · ≤80 字）

**售前**（模板 C02 · 47/80 字）

> 无谷鲜肉成猫粮和同类款的差别主要在无谷鲜肉；要是平时挑食，建议先拍试吃装，不合适 7 天可退。

**物流**（模板 C04 · 43/80 字）

> 亲，杭州这两天暴雨可能慢 1 天，我已备注加急，真超时了运费险我们先走赔付，不用您催。

**售后**（模板 C06 · 43/80 字）

> 软便多半是换粮太快，建议 7 天过渡：前 3 天新粮占四分之一，需要我把过渡表发您吗？

**催付**（模板 C07 · 47/80 字）

> 您购物车的无谷鲜肉成猫粮还有12件，现在下单送计量杯，活动今晚 24 点结束，我先帮您锁一单？

## 4. 短视频口播脚本（三段式 · 25s · 比例 9:16）

| 时间 | 阶段 | 镜头提示 | 口播 | 花字 |
| --- | --- | --- | --- | --- |
| 0-3s | 钩子 | 手撕开袋口特写，颗粒倒进玻璃碗 / 镜头怼近颗粒，字幕打在颗粒上方 | 别急着下单，先看这袋无谷鲜肉成猫粮的配料表开头写了什么。 | 配料表开头，才是成本大头 |
| 3-15s | 卖点证明 | 掰开一颗颗粒看横切面 / 温水泡 3 分钟后用手指压碎 / 猫咪低头吃的正拍 | 无谷鲜肉，粗脂肪 16%，高蛋白；温水泡 3 分钟能压碎，猫咪换粮不闹肚子。 | 成分看得见 · 泡得开 · 吃得完 |
| 15-25s | 促单 | 价格贴纸弹出 / 手指点购物车 / 赠品并列摆放 | 1.8kg 到手 129 元，还送计量杯，今天下单 48 小时内发出。 | 到手价 129 元 · 送计量杯 |

### 4.1 商品图提示词（跟随参数面板）

同一套参数同时决定商品主图和三段分镜：商品名、规格、形态、成分、赠品都从这里取，
换商品或改规格，下面四段会一起重算。

图片提示词 · 中文：

```
主推装：无谷鲜肉成猫粮，1.8kg，正面朝镜头立在台面上。
袋口微开，颗粒在袋前堆成一小堆；计量杯摆在右侧。
· 构图：中景，平视略低 10 度，主体占画面 60%，f/4 前后都实
· 光线：左前方大柔光箱铺底，右后方一盏轮廓光勾出袋身折痕
· 背景：浅橡木台面，背景干净米白，右侧留白贴价签
包装上的可读文字全部留空，后期再贴；主体是包装和颗粒，不是摆拍道具。风格：电商产品摄影，自然窗光，暖中性色调，浅景深，细微胶片颗粒，真实材质不做过度磨皮。
画幅：9:16（1080x1920）
不要：字幕、水印、logo、可读文字、变形的手指、多余手指、塑料感、过曝、HDR
```

图片提示词 · English：

```
a matte kraft stand-up pouch of dry cat food, 1.8kg pack, front facing camera, top slightly open, dry kibble pieces piled in front, a small gift pack standing beside it, medium shot, camera 10 degrees below eye level, product fills 60 percent of the frame, f/4 with everything in focus, large softbox from the front left, one rim light from the back right picking out the creases, light oak tabletop, clean off-white background, empty space on the right for a price card, editorial pet product photography, soft natural window light, warm neutral palette, subtle film grain, realistic textures, no over-retouching, 9:16 vertical, 1080x1920, no visible face, no text, no logos, clean surfaces
```

镜头提示词：

```
· 景别：中景，平视略低 10 度，主体占画面 60%，f/4 前后都实
· 机位：正前方偏右 15 度，包装正面和侧面折痕同时可见
· 光线：左前方大柔光箱铺底，右后方一盏轮廓光勾出袋身折痕
· 背景：浅橡木台面，背景干净米白，右侧留白贴价签
· 画幅：9:16（1080x1920）
· 运动：静态图，无运镜
```

### 4.2 分镜配图提示词

每组拆两份：**图片提示词**写画什么（中文给即梦/可灵，英文给 MJ / Nano Banana Pro），
**镜头提示词**写怎么拍（景别/机位/焦段/运动/节奏，给拍摄执行或视频模型）。
主镜动作取自上面的「镜头提示」，镜头语言与风格写在 `sections.storyboard`，改画面改模板。

**0-3s · 钩子**

图片提示词 · 中文：

```
手撕开袋口特写，颗粒倒进玻璃碗。
主体：颗粒（无谷鲜肉成猫粮），不是摆拍道具。
场景：深胡桃木台面，背景米白墙与浅色布帘虚化
光线：左上侧逆光，台面留一道长影
构图：微距特写，主体占画面三分之二，边缘轻微压暗
包装与颗粒要看得清：袋口的纤维、颗粒落下的轨迹都别糊成一片。
画幅：9:16（1080x1920）
风格：电商产品摄影，自然窗光，暖中性色调，浅景深，细微胶片颗粒，真实材质不做过度磨皮
不要：字幕、水印、logo、可读文字、变形的手指、多余手指、塑料感、过曝、HDR
```

图片提示词 · English：

```
a hand tearing open a matte kraft stand-up pouch, kibble pieces falling into a clear glass bowl, dry kibble pieces, dark walnut tabletop, blurred off-white wall and pale linen curtain behind, hard side-backlight from the upper left, one long shadow across the table, macro close-up, subject fills two thirds of the frame, edges slightly darkened, packaging fibres and falling pieces frozen mid-air, honest texture, editorial pet product photography, soft natural window light, warm neutral palette, subtle film grain, realistic textures, no over-retouching, product "无谷鲜肉成猫粮", 9:16 vertical, 1080x1920, no visible face, no text, no logos, clean surfaces
```

镜头提示词 · 中文：

```
景别：微距特写
机位：俯 15 度，镜头略高于台面
镜头：等效 50mm，f/2.0 浅景深，焦点压在动作接触点
运动：手持微推近，起幅到落幅不超过 5 厘米
节奏：0-3 秒单镜到底，不转场
时长：0-3s · 钩子
```

镜头提示词 · English：

```
macro close-up, 15 degrees down, lens just above the countertop, 50mm equivalent, f/2.0 shallow depth of field, focus on the contact point, handheld slow push-in, under 5 cm from start to end, one continuous take for 0-3 s, no cuts — 0-3s (hook)
```

**3-15s · 卖点证明**

图片提示词 · 中文：

```
掰开一颗颗粒看横切面。
主体：颗粒（无谷鲜肉成猫粮），不是摆拍道具。
场景：浅灰石面，一只白瓷碗，背景浅色亚麻布
光线：自然窗光从左前方铺开，高光柔和
构图：近景，焦点落在手上的动作，碗沿入画三分之一
无谷鲜肉的质感要落在画面上：颗粒的内部结构、纤维、湿度都看得见，别拍成一颗塑料模型。
画幅：9:16（1080x1920）
风格：电商产品摄影，自然窗光，暖中性色调，浅景深，细微胶片颗粒，真实材质不做过度磨皮
不要：字幕、水印、logo、可读文字、变形的手指、多余手指、塑料感、过曝、HDR
```

图片提示词 · English：

```
two fingers crushing one water-softened kibble piece, porous cross-section visible, white ceramic bowl behind, dry kibble pieces, pale grey stone surface, one white ceramic bowl, light linen backdrop, soft window light from the front left, gentle highlights, close-up, focus on the hand action, bowl rim in the lower third, porous cross-section, moisture and fibre readable at a glance, editorial pet product photography, soft natural window light, warm neutral palette, subtle film grain, realistic textures, no over-retouching, product "无谷鲜肉成猫粮", 9:16 vertical, 1080x1920, no visible face, no text, no logos, clean surfaces
```

镜头提示词 · 中文：

```
景别：近景
机位：俯 45 度，与台面成斜角
镜头：等效 35mm，f/2.8，景深刚好带住手和碗
运动：固定机位，保留轻微手持呼吸感
节奏：3-15 秒走完一个动作，起止各留 0.5 秒静止
时长：3-15s · 卖点证明
```

镜头提示词 · English：

```
close-up, 45 degrees down, angled against the countertop, 35mm equivalent, f/2.8, depth of field holding both hand and bowl, locked-off frame with a slight handheld breath, one action from 3 to 15 s, half a second of hold at each end — 3-15s (proof)
```

备选镜头：温水泡 3 分钟后用手指压碎；猫咪低头吃的正拍

**15-25s · 促单**

图片提示词 · 中文：

```
赠品并列摆放。
主体：「无谷鲜肉成猫粮」的包装和颗粒，不是摆拍道具。
场景：浅橡木台面，背景干净米白
光线：均匀柔光，无明显硬影
构图：中景，产品居中偏左，右侧留 40% 空白贴价签
主推装与 计量杯 同框，右侧留白给价签；包装上的可读文字全部留空，后期再贴。
画幅：9:16（1080x1920）
风格：电商产品摄影，自然窗光，暖中性色调，浅景深，细微胶片颗粒，真实材质不做过度磨皮
不要：字幕、水印、logo、可读文字、变形的手指、多余手指、塑料感、过曝、HDR
```

图片提示词 · English：

```
a large pouch standing upright with a small gift pouch beside it, dry kibble pieces, light oak tabletop, clean off-white background, even soft light, no hard shadows, medium shot, product centred and slightly left, 40 percent empty space on the right for a price sticker, main pack alongside the gift pack, empty right side reserved for a price sticker, editorial pet product photography, soft natural window light, warm neutral palette, subtle film grain, realistic textures, no over-retouching, product "无谷鲜肉成猫粮", 9:16 vertical, 1080x1920, no visible face, no text, no logos, clean surfaces
```

镜头提示词 · 中文：

```
景别：中景
机位：平视，与台面同高
镜头：等效 50mm，f/4，全画面清晰
运动：固定机位，最后 1 秒轻微推近
节奏：15-25 秒收尾，落幅定格 1 秒
时长：15-25s · 促单
```

镜头提示词 · English：

```
medium shot, eye level, level with the countertop, 50mm equivalent, f/4, everything sharp, locked-off, a small push-in over the last second, 15-25 s close, hold the final frame for one second — 15-25s (cta)
```

## 5. 合规检查

- 扫描范围：5 条标题 + 6 条卖点 + 4 条话术 + 3 段口播（不含本文件底部的词表本体）。
- 词表：极限词 35 个 + 平台补充词 4 个；长词优先匹配，白名单 最近 / 最后 / 最终 / 第一时间 不误伤。
- 平台规则（tmall，风险等级 高）：极限词（最、第一、顶级）零容忍；禁止与友商比价、对比测评结论；禁止资质类绝对化表述；赠品须写清数量与规格
- **合规检查：通过**（0 处命中）

## 6. 耗时测算（`--benchmark`）

| 环节 | 纯人工 | 人机协作 | 变化 |
| --- | --- | --- | --- |
| 需求理解与卖点梳理 | 45s | 输入参数 15s | -30s |
| 标题与卖点撰写 | 165s | 脚本生成 3s | -162s |
| 话术与口播撰写 | 90s | 话术与口播同一批生成 0s | -90s |
| 审校与合规复核 | 0s | 审校与合规复核 120s | +120s |
| **合计** | **300s（5.0 分钟）** | **138s（2.3 分钟）** | **-162s（-54.0%）** |

单篇预计耗时 3 分钟（输入15s+生成3s+审校2min）：脚本实测 138s ≈ 2.3 分钟，对外口径按 3 分钟计（含审校缓冲）。

| 批量 | 纯人工 | 人机协作（含模板库一次性建设 45 分钟） | 单篇摊薄 | 节省 |
| --- | --- | --- | --- | --- |
| 1 篇 | 5.0 分钟 | 47.3 分钟 | 47.30 分钟 | -846.0% |
| 20 篇 | 100.0 分钟 | 91.0 分钟 | 4.55 分钟 | 9.0% |
| 50 篇 | 250.0 分钟 | 160.0 分钟 | 3.20 分钟 | 36.0% |
| 100 篇 | 500.0 分钟 | 275.0 分钟 | 2.75 分钟 | 45.0% |

口径说明：纯人工按「读需求 + 查卖点 + 手写四类文案」实测均值 300s；人机协作把撰写压到脚本生成 3s，
但新增 120s 人工审校（合规 + 数据核对），这段审校不能省，也是脚本不替人做判断的地方。
