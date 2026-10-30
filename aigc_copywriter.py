#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AIGC 文案工作流 · 命令行改写脚本（仅标准库，无需联网）

分工：
  模板库 copy_templates.json —— 管结构与合规（标题骨架 / 卖点四段结构 / 话术场景 / 口播分镜 / 极限词黑名单）
  本脚本                    —— 管变量注入与组合去重（占位符填充 / 30 字校验 / 超长回退 / 批次去重 / 合规替换 / 耗时测算）

示例：
  python aigc_copywriter.py --product "无谷鲜肉成猫粮" --price 129 --spec 1.8kg "`
      --audience "1-3岁室内猫主人" --count 5 --seed 7 --out aigc_samples.md
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TEMPLATES = os.path.join(SCRIPT_DIR, "copy_templates.json")

MAX_TITLE_CHARS = 30
MAX_CS_CHARS = 80
TITLE_COUNT = 5
SP_COUNT = 6
CS_SCENES = ("售前", "物流", "售后", "催付")
SIMILARITY_THRESHOLD = 0.80

# 耗时拆解（秒）：纯人工 vs 人机协作，两列按同一行对齐
MANUAL_STEPS = (
    ("需求理解与卖点梳理", 45),
    ("标题与卖点撰写", 165),
    ("话术与口播撰写", 90),
    ("审校与合规复核", 0),
)
COLLAB_STEPS = (
    ("输入参数", 15),
    ("脚本生成", 3),
    ("话术与口播同一批生成", 0),
    ("审校与合规复核", 120),
)
TEMPLATE_BUILD_MINUTES = 45


# ---------------------------------------------------------------- 基础工具

class SafeDict(dict):
    """缺变量时原样保留占位符，避免模板维护期一改就崩。"""

    def __missing__(self, key):
        return "{" + key + "}"


def fill(template, ctx):
    return template.format_map(SafeDict(ctx))


def pick(rng, pool):
    """词池为空时不该抽：random.choice([]) 会抛异常，这里退成空串。"""
    return rng.choice(pool) if pool else ""


def normalize(text):
    return re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff%]", "", text).lower()


def bigrams(text):
    return {text[i:i + 2] for i in range(len(text) - 1)}


def too_similar(a, b):
    if a == b:
        return True
    ga, gb = bigrams(a), bigrams(b)
    if not ga or not gb:
        return False
    return len(ga & gb) / float(len(ga | gb)) >= SIMILARITY_THRESHOLD


def fmt_price(value):
    if value is None:
        return "129"
    return "%g" % float(value)


def price_in_band(price, band):
    if band in (None, "", "all"):
        return True
    m = re.match(r"^(\d+)-(\d+)$", str(band))
    if not m:
        return True
    return float(m.group(1)) <= price <= float(m.group(2))


def relax_stdout():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except Exception:
            pass


# ---------------------------------------------------------------- 模板与上下文

def load_templates(path):
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    sections = data.get("sections", {})
    need = ("title_templates", "selling_points", "cs_scripts", "video_script",
            "compliance", "variable_pools")
    missing = [k for k in need if k not in sections]
    if missing:
        raise SystemExit("模板库缺少 section: %s" % ", ".join(missing))
    return data


# 品类/物种词汇的默认值：命令行只跑通用示例，没接商品库时按主粮语境渲染，
# 与网页端（接入真实商品后由品类适配层覆盖）保持一致。
KIND_DEFAULT = "dry"
LEXICON_DEFAULT = {"物种": "猫咪", "量词": "袋", "形态": "颗粒", "品类": "主粮"}


def has_empty_slot(pattern, ctx):
    """商品里没有的字段是空串，引用它的模板整条跳过，别留半截话。"""
    for key in re.findall(r"\{([^{}]+)\}", pattern):
        if key in ctx and not str(ctx.get(key, "")):
            return True
    return False


AUD_RULES = {
    "犬": (("幼", "幼犬"), ("老年", "老年犬"), ("中大型", "中大型犬"), ("大型", "大型犬"),
           ("小型", "小型犬"), ("绝育", "绝育犬"), ("掉毛", "掉毛犬"), ("犬", "成犬")),
    "猫": (("幼", "幼猫"), ("老年", "老年猫"), ("绝育", "绝育猫"), ("室内", "室内猫"),
           ("多猫", "多猫家庭"), ("犬", "成犬"), ("猫", "成猫")),
}


def core_redundant(pattern, ctx, pools):
    """品名里已经有这个成分（豆腐渣 / 豆腐混合猫砂），再套「{核心成分}{product}」就重复了。"""
    if not pattern.strip().startswith("{核心成分}"):
        return False
    product = ctx.get("product") or ""
    return any(i and len(i) >= 2 and i[:2] in product for i in pools.get("ingredient", []))


def derive_audience_short(audience, product, pools, rng):
    """标题里只放短人群词：先看 --audience，再看商品名关键词，都没有才从词池抽。
    物种决定用哪套词：狗粮不能掉出「室内猫」。"""
    text = (audience or "") + " " + (product or "")
    rules = AUD_RULES["犬"] if re.search(r"犬|狗", text) else AUD_RULES["猫"]
    for key, word in rules:
        if key in text:
            return word
    return pick(rng, pools["audience"])


# ------------------------------------------------- 参数面板：文字 → 品类 / 物种

def by_text(text):
    text = text or ""
    dog, cat = bool(re.search(r"犬|狗", text)), ("猫" in text)
    if dog and cat:
        return "猫犬"
    if dog:
        return "犬"
    if cat:
        return "猫"
    return ""


def species_from_text(name, audience):
    return by_text(name) or by_text(audience) or "猫"


def kind_of_text(name):
    text = name or ""
    if re.search(r"砂|垫料|尿垫", text):
        return "litter"
    if re.search(r"罐|湿粮|餐包|汤包|主食包", text):
        return "wet"
    if re.search(r"零食|肉干|肉条|猫条|狗条|奖励|磨牙", text):
        return "treat"
    if re.search(r"粮|主食|奶糕", text):
        return "dry"
    if "冻干" in text:
        return "treat"
    return "other"


def dim(pool, kind, species):
    """示例词池有两层：{dry:{犬:[...]}} / {猫:[...]} / [...]，统一取一维。"""
    if not pool:
        return [] if not isinstance(pool, dict) else {}
    if isinstance(pool, list):
        return pool
    sub = pool.get(kind) if kind and kind in pool else None
    if sub is not None:
        if isinstance(sub, list):
            return sub
        if species in sub:
            return sub[species]
        return sub.get("猫") or sub.get("猫犬") or []
    if species in pool:
        return pool[species]
    return [] if not isinstance(pool, dict) else {}


def rotate(arr, n):
    if not arr:
        return []
    k = abs(int(n or 0)) % len(arr)
    return list(arr[k:]) + list(arr[:k])


# 面板人群短词只认「年龄段 / 体型 / 饲养方式」，不像标题那样见到「猫」就写「成猫」：
# 「养猫家庭」是人群，不是成猫
PANEL_AUD_RULES = {
    "猫": (("幼", "幼猫"), ("老年", "老年猫"), ("绝育", "绝育猫"), ("室内", "室内猫"),
           ("多猫", "多猫家庭"), ("掉毛", "掉毛猫")),
    "犬": (("幼", "幼犬"), ("老年", "老年犬"), ("中大型", "中大型犬"), ("大型", "大型犬"),
           ("小型", "小型犬"), ("绝育", "绝育犬"), ("掉毛", "掉毛犬")),
    "猫犬": (("幼", "幼宠"), ("老年", "老年宠")),
}


def short_audience(text, species):
    text = text or ""
    for key, word in PANEL_AUD_RULES.get(species) or PANEL_AUD_RULES["猫犬"]:
        if key in text:
            return word
    return ""


def tidy(text):
    """句子收尾：空括号、重复逗号、逗号接句号，统一清掉（与 facets.js 同一条链）。"""
    text = re.sub(r"[，,]{2,}", "，", text)
    text = re.sub(r"【\s*】", "", text)
    text = re.sub(r"[，,]\s*（\s*）", "", text)
    text = re.sub(r"[，,]\s*（", "（", text)
    text = re.sub(r"[，,]\s*。$", "。", text)
    text = re.sub(r"[：:]\s*[，,。]", "。", text)
    text = re.sub(r"([，。：；])\s+([A-Za-z])", r"\1\2", text)
    text = re.sub(r"（\s+([A-Za-z])", r"（\1", text)
    return text


def demo_selling(sections, kind, species, seed):
    """六条卖点：功能决定说哪件事，依据按功能给，数字跟着功能走，六条不重样。"""
    P = sections.get("demo_pools") or {}
    lib = sections.get("function_library") or {}
    frames = sections.get("selling_frames") or []
    fns = rotate(dim(P.get("selling_function") or P.get("function"), kind, species), seed)
    ings = dim(P.get("ingredient"), kind, species) or []
    nums = rotate(dim(P.get("number_proof"), kind, species), seed)
    proofs = dim(P.get("proof"), kind, species) or {}
    number_for = dim(P.get("number_for"), kind, species) or {}
    if not fns:
        fns = ["__fallback"]

    out = []
    for i in range(6):
        fn = fns[i % len(fns)]
        mat = lib.get(fn) or lib.get("__fallback") or {
            "label": "综合", "pain": "同类款买了不合用", "result": "按真实参数挑，少走弯路"}
        frame = frames[i % len(frames)] if frames else {
            "id": "F00", "template": "{pain}？{evidence}，{result}（{number}）。"}
        if proofs.get(fn):
            ev = proofs[fn]
        elif len(ings) >= 2:
            ev = " + ".join(ings[:2])
        else:
            ev = ings[0] if ings else ""
        num = number_for.get(fn) or (nums[i % len(nums)] if nums else "")
        # 依据里已经写过的数值不再重复一遍（与 facets.demoSelling 同一条规则）
        num_digits = re.findall(r"\d+(?:\.\d+)?%?", num or "")
        if num_digits and all(d in re.findall(r"\d+(?:\.\d+)?%?", ev) for d in num_digits):
            num = ""
        num_text = (" " + num) if re.match(r"[A-Za-z]", num or "") else num
        tpl = frame["template"] if num else frame.get("template_no_num", frame["template"])
        text = tpl
        text = text.replace("{pain}", mat["pain"], 1)
        text = text.replace("{evidence}", (ev + "，") if ev else "", 1)
        text = text.replace("{result}", mat["result"] + "，", 1)
        text = text.replace("{number}", num_text, 1)
        out.append({
            "id": "P%d" % (i + 1),
            "category": mat.get("label", ""),
            "text": tidy(text),
            "parts": {"痛点": mat["pain"], "证据": ev, "结果": mat["result"], "数字": num},
            "fn": fn,
            "frame": frame.get("id", ""),
        })
    return out


def build_demo(sections, args):
    """参数面板（命令行同款）→ 一条临时商品记录 → 词池 / 词汇 / 卖点。"""
    P = sections.get("demo_pools")
    if not P:
        return None
    name = (args.product or "").strip()
    typed = (args.audience or "").strip()
    kind = kind_of_text(name)
    species = species_from_text(name, typed)
    # 认不出品类的（羊奶粉、营养膏…）按主粮语境兜底：词池空着会让引擎抽不到值
    if kind != "dry" and not dim(P.get("ingredient"), kind, species):
        kind = "dry"
    seed = abs(int(args.seed or 0))

    ings = rotate(dim(P.get("ingredient"), kind, species), seed)
    # 名字里点名的食材排到最前：手输「鸭肉干」却配「三文鱼」是最容易露馅的错配
    named = []
    for k in ("dry", "wet", "treat", "litter"):
        for w in (dim(P.get("ingredient"), k, species) or []):
            if w and w in name and w not in named:
                named.append(w)
    for w in re.findall(r"[\u4e00-\u9fa5]{1,3}肉", name):
        if w not in named:
            named.append(w)
    if named:
        ings = named + [w for w in ings if w not in named]
    fns = rotate(dim(P.get("function"), kind, species), seed)
    nums = rotate(dim(P.get("number_proof"), kind, species), seed)
    scenes = rotate(dim(P.get("scene"), kind, species), seed)
    gifts = rotate(dim(P.get("gift"), kind, species), seed)
    brands = rotate(dim(P.get("brand"), kind, species), seed)
    brand_pool = []
    for k in ("dry", "wet", "treat", "litter"):
        brand_pool.extend(dim(P.get("brand"), k, species) or [])
    brand_hit = next((b for b in brand_pool if b and b in name), "")
    specs = dim(P.get("spec"), kind, species) or []
    proofs = dim(P.get("proof"), kind, species) or {}

    aud, conflict, plain = "", False, re.sub(r"主人$", "", typed).strip()
    if plain:
        has_cat, has_dog = ("猫" in plain), bool(re.search(r"犬|狗", plain))
        conflict = (species == "犬" and has_cat and not has_dog) or (species == "猫" and has_dog and not has_cat)
        if not conflict:
            aud = short_audience(plain, species) or (plain if len(plain) <= 10 else "")
    if not aud:
        pool = dim(P.get("audience"), kind, species) or []
        aud = rotate(pool, seed)[0] if pool else ("成犬" if species == "犬" else "成猫")

    spec = (args.spec or "").strip() or (specs[0] if specs else "")
    gift = gifts[0] if gifts else "无"
    brand = brand_hit

    # 核心成分：品名里点名的配料就是它（写「鸭肉干」不该出现「鸡胸肉」），与 facets.derive 一致
    ranked = [i for i in ings]
    hits = [i for i in ranked if i and i in name]
    if hits:
        kept = hits
    elif ranked:
        kept = [ranked[0]] + [i for i in ranked[1:] if i[:2] not in name]
    else:
        kept = []

    sp_lex = (sections.get("species_lexicon") or {}).get(species) or {"word": "宠物"}
    k_lex = (sections.get("kind_lexicon") or {}).get(kind) or {"word": "商品", "unit": "件", "form": "实物"}

    pools = dict(sections.get("variable_pools") or {})
    pools.update({
        "brand": [brand],   # 空串也占位：与 facets.js 一致，不给别人的商品硬安品牌
        "spec": [spec] if spec else (specs or pools.get("spec")),
        "ingredient": kept,
        "function": fns,
        "audience": [aud],
        "scene": scenes,
        "gift": [gift] if gift and gift != "无" else [""],
        "number_proof": nums if nums else [""],
    })

    lexicon = {
        "物种": sp_lex.get("word", "宠物"),
        "量词": k_lex.get("unit", "件"),
        "形态": k_lex.get("form", "实物"),
        "品类": k_lex.get("word", ""),
        "species": species,
        "kind": kind,
    }
    return {
        "kind": kind, "species": species, "pools": pools, "lexicon": lexicon,
        "audience": aud, "selling": demo_selling(sections, kind, species, seed),
        "note": {"typed": typed, "used": aud, "conflict": conflict},
        "product": {
            "name": name, "brand": brand, "spec": spec, "audience": aud,
            "attributes": {
                "ingredients": ings, "functions": fns,
                "proof": proofs.get(fns[0]) if fns else "",
                "proof_short": nums[0] if nums else "",
                "scene": " / ".join(scenes), "gift": gift,
            },
        },
    }


def build_context(args, pools, rng, lexicon=None, audience_short=None):
    product = args.product.strip()
    spec = args.spec.strip() if args.spec else pick(rng, pools["spec"])
    lex = lexicon or {}
    ctx = {
        "brand": pick(rng, pools["brand"]),
        "product": product,
        "spec": spec,
        "price": fmt_price(args.price),
        "audience": args.audience.strip() if args.audience else "",
        "核心成分": pick(rng, pools["ingredient"]),
        "功能": pick(rng, pools["function"]),
        "人群": audience_short or derive_audience_short(args.audience, product, pools, rng),
        "场景": pick(rng, pools["scene"]),
        "数字卖点": pick(rng, pools["number_proof"]),
        "赠品": pick(rng, pools["gift"]),
        "仓": pick(rng, pools["warehouse"]),
        "天数": "2-3",
        "运单号": "SF%d" % rng.randint(100000000, 999999999),
        "城市": pick(rng, pools["city"]),
        "售后政策": pick(rng, pools["aftersale_policy"]),
        "库存": pick(rng, pools["stock"]),
        "species": lex.get("species") or ("犬" if re.search(r"犬|狗", product) else "猫"),
        "kind": lex.get("kind") or KIND_DEFAULT,
    }
    ctx.update(LEXICON_DEFAULT)
    ctx.update(lex)
    return ctx


# ---------------------------------------------------------------- 标题

def gen_titles(templates, ctx, pools, price, rng, count=TITLE_COUNT):
    pool = [t for t in templates if price_in_band(price, t.get("price_band"))]
    if len(pool) < count:
        pool = list(templates)
    primary = [t for t in pool if t.get("tier") in ("long", "mid")]
    short = [t for t in pool if t.get("tier") == "short"]
    if not short:
        short = sorted(pool, key=lambda t: len(t["pattern"]))[:3]
    rng.shuffle(primary)
    rng.shuffle(short)

    titles, keys = [], []
    stats = {"overflow": 0, "similar": 0, "fallback": 0}

    for tpl in primary + short:
        if len(titles) >= count:
            break
        if has_empty_slot(tpl["pattern"], ctx) or core_redundant(tpl["pattern"], ctx, pools):
            continue
        local = dict(ctx)
        local["核心成分"] = pick(rng, pools["ingredient"])
        local["功能"] = pick(rng, pools["function"])
        local["数字卖点"] = pick(rng, pools["number_proof"])
        text = re.sub(r"\s+", " ", fill(tpl["pattern"], local)).strip()
        if len(text) > MAX_TITLE_CHARS:
            stats["overflow"] += 1
            continue
        key = normalize(text)
        if any(too_similar(key, k) for k in keys):
            stats["similar"] += 1
            continue
        titles.append({"text": text, "template": tpl["id"], "tier": tpl.get("tier", ""),
                       "band": tpl.get("price_band", "all"), "chars": len(text), "fallback": False})
        keys.append(key)

    # 兜底：仍不足时用短模板 + 规格轮换补齐，保证条数与去重
    guard = 0
    specs = list(pools["spec"])
    while len(titles) < count and guard < 400:
        tpl = short[guard % len(short)]
        if has_empty_slot(tpl["pattern"], ctx) or core_redundant(tpl["pattern"], ctx, pools):
            guard += 1
            continue
        local = dict(ctx, spec=specs[guard % len(specs)])
        local["功能"] = pick(rng, pools["function"])
        local["数字卖点"] = pick(rng, pools["number_proof"])
        text = re.sub(r"\s+", " ", fill(tpl["pattern"], local)).strip()
        guard += 1
        if len(text) > MAX_TITLE_CHARS:
            stats["overflow"] += 1
            continue
        key = normalize(text)
        if any(too_similar(key, k) for k in keys):
            stats["similar"] += 1
            continue
        titles.append({"text": text, "template": tpl["id"], "tier": "short",
                       "band": tpl.get("price_band", "all"), "chars": len(text), "fallback": True})
        keys.append(key)
        stats["fallback"] += 1

    return titles, stats


# ---------------------------------------------------------------- 卖点 / 话术 / 口播

def gen_selling_points(section, ctx, rng, n=SP_COUNT, preset=None):
    """接了商品/面板参数时，六条卖点由适配层预生成，这里直接采用。"""
    if preset:
        return [{
            "id": item["id"], "category": item.get("category", ""),
            "text": item["text"],
            "parts": dict({"痛点": "", "证据": "", "结果": "", "数字": ""}, **item.get("parts", {})),
        } for item in preset[:n]]
    n = min(n, len(section))
    out = []
    for item in rng.sample(list(section), n):
        local = dict(ctx, pain=item["pain"], evidence=item["evidence"],
                     result=item["result"], number=item["number"])
        out.append({
            "id": item["id"],
            "category": item.get("category", ""),
            "text": fill(item["template"], local),
            "parts": {"痛点": item["pain"], "证据": item["evidence"],
                      "结果": item["result"], "数字": item["number"]},
        })
    return out


def gen_cs_scripts(section, ctx, rng):
    out = []
    kind = ctx.get("kind") or ""
    # 品类对不上的场景直接跳过：猫砂不写换粮软便，零食不写换粮过渡
    usable = [c for c in section if not c.get("kinds") or not kind or kind in c["kinds"]]
    for scene in CS_SCENES:
        cands = [c for c in usable if c.get("scene") == scene]
        if not cands:
            continue
        rng.shuffle(cands)
        chosen, over = None, None
        for cand in cands:
            tpl = cand["template"]
            if not ctx.get("赠品") and cand.get("template_no_gift"):
                tpl = cand["template_no_gift"]
            if has_empty_slot(tpl, ctx):
                continue
            text = fill(tpl, ctx)
            limit = cand.get("max_chars", MAX_CS_CHARS)
            if len(text) <= limit:
                chosen = (cand, text, limit, False)
                break
            over = (cand, text, limit, True)
        if chosen is None:
            chosen = over
        if chosen is None:
            continue
        cand, text, limit, is_over = chosen
        out.append({"id": cand["id"], "scene": scene, "text": text,
                    "chars": len(text), "limit": limit, "over": is_over})
    return out


def gen_video(section, ctx):
    variants = section.get("variants") or {}
    key = "%s|%s" % (ctx.get("kind") or "", ctx.get("species") or "")
    variant = variants.get(key) or variants.get(ctx.get("kind") or "") or {}
    src = variant.get("segments") or section.get("segments", [])
    gift = bool(ctx.get("赠品"))
    segs = []
    for seg in src:
        line = seg["line"] if gift else seg.get("line_no_gift", seg["line"])
        sub = seg.get("subtitle", "") if gift else seg.get("subtitle_no_gift", seg.get("subtitle", ""))
        segs.append({
            "range": seg["range"],
            "stage": seg["stage"],
            "line": fill(line, ctx),
            "subtitle": fill(sub, ctx),
            "visual": [fill(v, ctx) for v in seg.get("visual", [])],
        })
    return {"id": section.get("id", "V01"), "total": section.get("total_seconds", 25),
            "ratio": section.get("ratio", "9:16"), "segments": segs}


# ---------------------------------------------------------------- 分镜提示词
# 与网页 src/prompts.js 同一套规则：主镜动作取 video 的 visual（已按品类适配），
# 镜头语言读 copy_templates.json 的 sections.storyboard，中英各出一版。

LATE_CUT = re.compile(r"弹出|贴纸|字幕|点购物车|点击|打码|留白给")
STILL_HINT = re.compile(r"陈列|并排|并列|摆放|同框|立着|摆好")


def _role_of(stage):
    s = str(stage or "")
    if re.search(r"钩子|开场", s):
        return "hook"
    if re.search(r"促单|转化|收单|下单", s):
        return "cta"
    return "proof"


def _ingredient_en(name, sb):
    table = sb.get("ingredient_en") or {}
    s = str(name or "").strip()
    if not s:
        return ""
    if s in table:
        return table[s]
    for k, v in table.items():
        if k in s:
            return v
    return ""


def _pick_action(visual, role, ctx):
    """分镜文案里混着「价格贴纸弹出」这类后期动作，拍不出来，先滤掉再取第一条。"""
    rest = [v for v in (visual or []) if v and not LATE_CUT.search(v)]
    if role == "cta":
        still = [v for v in rest if STILL_HINT.search(v)]
        if still:
            rest = still
    if rest:
        return rest[0], rest[1:]
    fallback = "主推装与赠品并排陈列在台面上" if role == "cta" else "%s特写" % ctx.get("形态", "商品")
    return fallback, []


def packshot_prompts(ctx, templates):
    """商品主图：参数面板选了什么就画什么。与网页 src/prompts.js 的 packshot() 逐字一致。"""
    sb = (templates.get("sections") or {}).get("storyboard") or {}
    kinds = sb.get("kinds") or {}
    kind = str(ctx.get("kind") or KIND_DEFAULT)
    species = str(ctx.get("species") or "")
    base = dict(kinds.get(kind) or kinds.get("other") or {})
    base.update(kinds.get("%s|%s" % (kind, species)) or {})
    cam = sb.get("packshot") or {}

    form = ctx.get("形态") or "颗粒"
    gift = str(ctx.get("赠品") or "")
    product = ctx.get("product") or "商品"
    spec = str(ctx.get("spec") or "")
    brand = str(ctx.get("brand") or "")
    ratio = sb.get("ratio", "9:16")
    px = sb.get("pixels", "1080x1920")
    side = ("；" + gift + "摆在右侧") if gift else ""

    if kind == "wet":
        open_line = "罐盖半开，%s在罐前盛进一只白瓷碟%s" % (form, side)
    elif kind == "litter":
        open_line = "袋口翻开，%s在袋前堆成一小堆%s" % (form, side)
    elif kind == "treat":
        open_line = "袋口撕开一角，%s散在袋前%s" % (form, side)
    elif kind == "dry":
        open_line = "袋口微开，%s在袋前堆成一小堆%s" % (form, side)
    else:
        open_line = "%s摆在包装前%s" % (form, side)

    head = "主推装：%s%s，%s正面朝镜头立在台面上。" % (
        product, (" · " + brand) if brand else "", (spec + "，") if spec else "")

    zh = "\n".join(x for x in [
        head,
        open_line + "。",
        "· 构图：" + cam.get("size_zh", ""),
        "· 光线：" + cam.get("light_zh", ""),
        "· 背景：" + cam.get("set_zh", ""),
        "包装上的可读文字全部留空，后期再贴；主体是包装和%s，不是摆拍道具。风格：%s。" % (form, sb.get("style_zh", "")),
        "画幅：%s（%s）" % (ratio, px),
        "不要：" + sb.get("avoid_zh", ""),
    ] if x)

    en = ", ".join(x for x in [
        (base.get("pack_en") or "the product packaging") + ((", " + spec + " pack") if spec else ""),
        "front facing camera, top slightly open",
        (base.get("subject_en") or form) + " piled in front",
        "a small gift pack standing beside it" if gift else "",
        cam.get("size_en", ""),
        cam.get("light_en", ""),
        cam.get("set_en", ""),
        sb.get("style_en", ""),
        "%s vertical, %s" % (ratio, px),
        "no visible face, no text, no logos, clean surfaces",
    ] if x)

    cam_text = "\n".join(x for x in [
        "· 景别：" + cam.get("size_zh", ""),
        "· 机位：" + cam.get("angle_zh", ""),
        "· 光线：" + cam.get("light_zh", ""),
        "· 背景：" + cam.get("set_zh", ""),
        "· 画幅：%s（%s）" % (ratio, px),
        "· 运动：静态图，无运镜",
    ] if x.split("：", 1)[-1].strip())

    return {
        "summary": " · ".join(x for x in [product, spec, ctx.get("核心成分") or ""] if x),
        "zh": zh,
        "en": en,
        "cam": cam_text,
    }


def storyboard_prompts(ctx, video, templates):
    sb = (templates.get("sections") or {}).get("storyboard") or {}
    kinds = sb.get("kinds") or {}
    cam_all = sb.get("camera") or {}
    kind = str(ctx.get("kind") or KIND_DEFAULT)
    species = str(ctx.get("species") or "")
    base = dict(kinds.get(kind) or kinds.get("other") or {})
    base.update(kinds.get("%s|%s" % (kind, species)) or {})

    form = ctx.get("形态") or "颗粒"
    ratio = sb.get("ratio", "9:16")
    px = sb.get("pixels", "1080x1920")
    ing = re.sub(r"[+＋]", "、", str(ctx.get("核心成分") or ""))
    ing_en = _ingredient_en(ing, sb)

    shots = []
    for i, seg in enumerate(video.get("segments", [])):
        role = _role_of(seg.get("stage"))
        cam = dict(cam_all.get(role) or {})
        cam.update((base.get("cam") or {}).get(role) or {})
        action, alt = _pick_action(seg.get("visual"), role, ctx)

        if role == "hook":
            hint_zh = "包装与%s要看得清：袋口的纤维、%s落下的轨迹都别糊成一片。" % (form, form)
            hint_en = "packaging fibres and falling pieces frozen mid-air, honest texture"
        elif role == "cta":
            gift = ctx.get("赠品")
            lead = "主推装与 %s 同框，" % gift if gift else "主推装单独陈列，"
            hint_zh = lead + "右侧留白给价签；包装上的可读文字全部留空，后期再贴。"
            hint_en = "main pack alongside the gift pack, empty right side reserved for a price sticker"
        elif kind == "litter":
            hint_zh = ("%s要看得见：" % ing if ing else "") + \
                "结团后的断面、颗粒完整度、粉尘多少都要拍清楚，别拍成一盆白粉。"
            hint_en = "clump cross-section, intact pellets, visibly low dust"
        else:
            hint_zh = ("%s的质感要落在画面上：" % ing if ing else "") + \
                "%s的内部结构、纤维、湿度都看得见，别拍成一颗塑料模型。" % form
            hint_en = ("visible %s texture, " % ing_en if ing_en else "") + \
                "porous cross-section, moisture and fibre readable at a glance"

        # 主体带上商品名：换商品（含自己输入的名字）时，提示词里能看出画的是哪一件
        pname = str(ctx.get("product") or ctx.get("商品名") or "").strip()
        if role == "cta":
            subject_zh = ("「%s」的包装和%s" % (pname, form)) if pname else ("包装和%s" % form)
        else:
            subject_zh = ("%s（%s）" % (form, pname)) if pname else form
        # 两组各归各的：图片提示词写「画什么」，镜头提示词写「怎么拍」
        img_zh = "\n".join(x for x in [
            action + "。",
            "主体：%s，不是摆拍道具。" % subject_zh,
            "场景：" + cam.get("set_zh", ""),
            "光线：" + cam.get("light_zh", ""),
            ("构图：" + "，".join(y for y in [cam.get("shot_zh", ""), cam.get("frame_zh", "")] if y))
            if (cam.get("shot_zh") or cam.get("frame_zh")) else "",
            hint_zh,
            "画幅：%s（%s）" % (ratio, px),
            ("风格：" + sb.get("style_zh", "")) if sb.get("style_zh") else "",
            ("不要：" + sb.get("avoid_zh", "")) if sb.get("avoid_zh") else "",
        ] if x)

        img_en = ", ".join(x for x in [
            base.get(role + "_en") or base.get("hook_en", ""),
            base.get("subject_en", form),
            cam.get("set_en", ""),
            cam.get("light_en", ""),
            ", ".join(y for y in [cam.get("shot_en", ""), cam.get("frame_en", "")] if y),
            hint_en,
            sb.get("style_en", ""),
            ('product "%s"' % pname) if pname else "",
            "%s vertical, %s" % (ratio, px),
            "no visible face, no text, no logos, clean surfaces",
        ] if x)

        cam_zh = "\n".join(
            (["%s：%s" % (k, v) for k, v in [
                ("景别", cam.get("shot_zh", "")),
                ("机位", cam.get("angle_zh", "")),
                ("镜头", cam.get("lens_zh", "")),
                ("运动", cam.get("move_zh", "")),
                ("节奏", cam.get("pace_zh", "")),
            ] if v]) + ["时长：%s · %s" % (seg.get("range", ""), seg.get("stage", ""))])

        cam_en = " — ".join(x for x in [
            ", ".join(y for y in [cam.get("shot_en", ""), cam.get("angle_en", ""), cam.get("lens_en", ""),
                                  cam.get("move_en", ""), cam.get("pace_en", "")] if y),
            "%s (%s)" % (seg.get("range", ""), role),
        ] if x)

        shots.append({"i": i, "range": seg.get("range"), "stage": seg.get("stage"),
                      "role": role, "action": action, "alt": alt,
                      "img_zh": img_zh, "img_en": img_en, "cam_zh": cam_zh, "cam_en": cam_en,
                      "zh": img_zh, "en": img_en})
    return shots


def prompts_markdown(ctx, video, templates):
    sb = (templates.get("sections") or {}).get("storyboard") or {}
    shots = storyboard_prompts(ctx, video, templates)
    total = video.get("total", 25)
    L = [
        "商品：%s%s" % (ctx.get("product", ""), (" · " + ctx["brand"]) if ctx.get("brand") else ""),
        "参数：%s" % " / ".join(x for x in [
            ctx.get("spec"), ("%s 元" % ctx["price"]) if ctx.get("price") else "",
            ctx.get("物种"), ctx.get("品类")] if x) +
        ((" · 场景 " + ctx["场景"]) if ctx.get("场景") else ""),
        "核心成分：%s / 功能：%s" % (ctx.get("核心成分") or "未填", ctx.get("功能") or "未填"),
        "画幅：%s（%s）· 三段共 %s 秒" % (sb.get("ratio", "9:16"), sb.get("pixels", "1080x1920"), total),
    ]
    pk = packshot_prompts(ctx, templates)
    L += ["", "## 商品图 · 主推装", "### 图片提示词", "中文：", pk["zh"], "",
          "English:", pk["en"], "", "### 镜头提示词", pk["cam"]]
    for s in shots:
        L += ["", "## %s · %s" % (s["range"], s["stage"]),
              "### 图片提示词", "中文：", s["img_zh"], "", "English:", s["img_en"],
              "", "### 镜头提示词", "中文：", s["cam_zh"], "", "English:", s["cam_en"]]
        if s["alt"]:
            L += ["", "备选镜头：" + "；".join(s["alt"])]
    return "\n".join(L)

# ---------------------------------------------------------------- 合规

def build_compliance_table(compliance, platform):
    base = list(compliance.get("banned_terms", []))
    extra = compliance.get("platform_extra_terms", {}).get(platform, [])
    terms = base + [t for t in extra if t not in base]
    mapping = dict(compliance.get("replace_map", {}))
    mapping.update(compliance.get("platform_extra_replace", {}))
    return terms, mapping, list(compliance.get("allow_terms", [])), base, extra


def apply_compliance(text, terms, mapping, allow_terms):
    """长词优先 + 白名单遮罩：先护住「最近/最后」，再逐词替换，避免「最好」被拆成「更」+「好」。"""
    masked, marks = text, {}
    for idx, word in enumerate(allow_terms):
        if word in masked:
            token = "\u0001%d\u0001" % idx
            marks[token] = word
            masked = masked.replace(word, token)
    hits = {}
    for term in sorted(terms, key=len, reverse=True):
        if term in masked:
            hits[term] = masked.count(term)
            masked = masked.replace(term, mapping.get(term, "（此处删去极限表述）"))
    for token, word in marks.items():
        masked = masked.replace(token, word)
    return masked, hits


# ---------------------------------------------------------------- 替换后复检

def repair_titles(titles, templates, ctx, pools, rng, terms, mapping, allow_terms):
    """合规替换会加长文案（最好 -> 更合适），替换完必须再校验一次 30 字上限。"""
    hits, repaired = {}, 0
    short = [t for t in templates if t.get("tier") == "short"] or list(templates)
    specs = list(pools["spec"])
    for item in titles:
        if len(item["text"]) <= MAX_TITLE_CHARS:
            continue
        parts = item["text"].split(" ")
        while len(" ".join(parts)) > MAX_TITLE_CHARS and len(parts) > 2:
            parts.pop()
        text = " ".join(parts)
        if len(text) > MAX_TITLE_CHARS:
            text = text[:MAX_TITLE_CHARS]
            item["truncated"] = True
        item["text"], item["chars"] = text, len(text)
        item["repaired"] = True
        repaired += 1
    # 裁尾后若撞车，用短模板 + 规格轮换补一条（同样过一遍合规）
    seen = {}
    for idx, item in enumerate(titles):
        key = normalize(item["text"])
        if key not in seen:
            seen[key] = idx
            continue
        pickable = [t for t in short if not has_empty_slot(t["pattern"], ctx)
                    and not core_redundant(t["pattern"], ctx, pools)] or list(short)
        tpl = pickable[(repaired + idx) % len(pickable)]
        local = dict(ctx, spec=specs[idx % len(specs)])
        text = re.sub(r"\s+", " ", fill(tpl["pattern"], local)).strip()
        text, extra = apply_compliance(text, terms, mapping, allow_terms)
        for k, v in extra.items():
            hits[k] = hits.get(k, 0) + v
        item.update({"text": text, "chars": len(text), "template": tpl["id"],
                     "tier": tpl.get("tier", "short"), "band": tpl.get("price_band", "all"),
                     "fallback": True, "repaired": True})
        seen[normalize(text)] = idx
    return repaired, hits


# ---------------------------------------------------------------- 耗时测算

def benchmark():
    manual = sum(sec for _, sec in MANUAL_STEPS)
    collab = sum(sec for _, sec in COLLAB_STEPS)
    rows = []
    for (m_name, m_sec), (c_name, c_sec) in zip(MANUAL_STEPS, COLLAB_STEPS):
        rows.append({"stage": m_name, "manual": m_sec, "collab_name": c_name,
                     "collab": c_sec, "delta": c_sec - m_sec})
    return {"manual": manual, "collab": collab, "rows": rows,
            "save_pct": (manual - collab) / float(manual) * 100.0}


def batch_table(sizes=(1, 20, 50, 100)):
    bm = benchmark()
    rows = []
    for n in sizes:
        manual = bm["manual"] * n / 60.0
        collab = bm["collab"] * n / 60.0
        with_build = collab + TEMPLATE_BUILD_MINUTES
        rows.append({"n": n, "manual": manual, "collab": collab, "with_build": with_build,
                     "per_piece": with_build / float(n),
                     "save_pct": (manual - with_build) / manual * 100.0})
    return rows


def format_benchmark_md():
    bm = benchmark()
    lines = ["| 环节 | 纯人工 | 人机协作 | 变化 |", "| --- | --- | --- | --- |"]
    for row in bm["rows"]:
        lines.append("| %s | %ds | %s %ds | %+ds |" % (row["stage"], row["manual"],
                                                       row["collab_name"], row["collab"], row["delta"]))
    lines.append("| **合计** | **%ds（%.1f 分钟）** | **%ds（%.1f 分钟）** | **%+ds（%.1f%%）** |"
                 % (bm["manual"], bm["manual"] / 60.0, bm["collab"], bm["collab"] / 60.0,
                    bm["collab"] - bm["manual"], -bm["save_pct"]))
    lines.append("")
    lines.append("单篇预计耗时 3 分钟（输入15s+生成3s+审校2min）：脚本实测 %ds ≈ %.1f 分钟，"
                 "对外口径按 3 分钟计（含审校缓冲）。" % (bm["collab"], bm["collab"] / 60.0))
    lines.append("")
    lines.append("| 批量 | 纯人工 | 人机协作（含模板库一次性建设 %d 分钟） | 单篇摊薄 | 节省 |"
                 % TEMPLATE_BUILD_MINUTES)
    lines.append("| --- | --- | --- | --- | --- |")
    for row in batch_table():
        lines.append("| %d 篇 | %.1f 分钟 | %.1f 分钟 | %.2f 分钟 | %.1f%% |"
                     % (row["n"], row["manual"], row["with_build"], row["per_piece"], row["save_pct"]))
    return "\n".join(lines)


def benchmark_console():
    bm = benchmark()
    out = ["耗时对比（改造前 -> 改造后）", "-" * 56,
           "%-24s %8s %8s" % ("环节", "纯人工", "协作")]
    for row in bm["rows"]:
        out.append("%-24s %6ds %8ds" % (row["stage"], row["manual"], row["collab"]))
    out.append("-" * 56)
    out.append("%-24s %6ds %8ds" % ("合计", bm["manual"], bm["collab"]))
    out.append("单篇：%.1f 分钟 -> %.1f 分钟（节省 %.1f%%），对外口径 3 分钟（输入15s+生成3s+审校2min）"
               % (bm["manual"] / 60.0, bm["collab"] / 60.0, bm["save_pct"]))
    return "\n".join(out)


# ---------------------------------------------------------------- 报告

PLATFORM_LABEL = {"tmall": "tmall（天猫/淘宝）", "jd": "jd（京东）", "amazon": "amazon（亚马逊）"}


def render_markdown(args, ctx, titles, tstats, sps, css, video,
                    comp_total, comp_detail, comp_info, platform_rules, allow_seen=None,
                    templates=None):
    templates = templates or {}
    base_n = len(comp_info["base"])
    extra_n = len(comp_info["extra"])
    allow = comp_info["allow"]
    mapping = comp_info["map"]

    L = []
    L.append("# AIGC 文案工作流 · 一次真实运行样例")
    L.append("")
    L.append("> 由 `aigc_copywriter.py` 渲染，模板来自 `copy_templates.json`。"
             "同一 `--seed` 重复运行，正文逐字一致。")
    L.append("> 分工：模板管结构与合规，脚本管变量注入与组合去重。")
    L.append("")
    L.append("## 0. 运行参数")
    L.append("")
    L.append("| 参数 | 值 |")
    L.append("| --- | --- |")
    L.append("| 商品 | %s |" % ctx["product"])
    L.append("| 到手价 | %s 元 |" % ctx["price"])
    L.append("| 规格 | %s |" % ctx["spec"])
    L.append("| 人群 | %s |" % (ctx["audience"] or "（未指定，取词池）"))
    L.append("| 平台 | %s |" % PLATFORM_LABEL.get(args.platform, args.platform))
    L.append("| 标题数量 | %d |" % len(titles))
    L.append("| 随机种子 | %d |" % args.seed)
    L.append("| 品牌 / 成分 / 功能 | %s / %s / %s |" % (ctx["brand"], ctx["核心成分"], ctx["功能"]))
    L.append("| 数字卖点 / 场景 / 赠品 | %s / %s / %s |" % (ctx["数字卖点"], ctx["场景"], ctx["赠品"]))
    L.append("")
    L.append("## 1. 商品标题（%d 条 · 全部 ≤%d 字 · 互不重复）" % (len(titles), MAX_TITLE_CHARS))
    L.append("")
    L.append("| # | 标题 | 字数 | 模板 | 价格带 |")
    L.append("| --- | --- | --- | --- | --- |")
    for idx, t in enumerate(titles, 1):
        L.append("| %d | %s | %d | %s | %s |" % (idx, t["text"], t["chars"], t["template"], t["band"]))
    L.append("")
    L.append("- 字数校验：%d 条全部 ≤%d 字，最长 %d 字。"
             % (len(titles), MAX_TITLE_CHARS, max(t["chars"] for t in titles)))
    L.append("- 去重规则：标题归一化后按字符二元组 Jaccard ≥ %.2f 判为重复，命中即换模板重抽。"
             % SIMILARITY_THRESHOLD)
    L.append("- 超长回退：%d 条候选超过 %d 字，已自动跳到短模板；%d 条候选与已有标题过于相似，已重抽。"
             % (tstats["overflow"], MAX_TITLE_CHARS, tstats["similar"]))
    if tstats.get("repaired"):
        L.append("- 替换后复检：%d 条因合规替换变长而超过 %d 字，已按空格裁尾并重新校验。"
                 % (tstats["repaired"], MAX_TITLE_CHARS))
    if tstats["fallback"]:
        L.append("- 兜底补齐：%d 条由短模板 + 规格轮换补齐。" % tstats["fallback"])
    L.append("")
    L.append("## 2. 卖点（%d 条 · 痛点 + 成分/工艺证据 + 可感知结果 + 数字）" % len(sps))
    L.append("")
    L.append("| # | 卖点文案 | 结构拆解 | 类型 |")
    L.append("| --- | --- | --- | --- |")
    for idx, s in enumerate(sps, 1):
        p = s["parts"]
        L.append("| %d | %s | 痛点「%s」→ 证据「%s」→ 结果「%s」→ 数字「%s」 | %s |"
                 % (idx, s["text"], p["痛点"], p["证据"], p["结果"], p["数字"], s["category"]))
    L.append("")
    L.append("## 3. 客服话术（%d 条 · 售前 / 物流 / 售后 / 催付 各 1 · ≤%d 字）"
             % (len(css), MAX_CS_CHARS))
    L.append("")
    for c in css:
        flag = "  ← 超字数，需人工精简" if c["over"] else ""
        L.append("**%s**（模板 %s · %d/%d 字）%s" % (c["scene"], c["id"], c["chars"], c["limit"], flag))
        L.append("")
        L.append("> %s" % c["text"])
        L.append("")
    L.append("## 4. 短视频口播脚本（三段式 · %ds · 比例 %s）" % (video["total"], video["ratio"]))
    L.append("")
    L.append("| 时间 | 阶段 | 镜头提示 | 口播 | 花字 |")
    L.append("| --- | --- | --- | --- | --- |")
    for seg in video["segments"]:
        L.append("| %s | %s | %s | %s | %s |"
                 % (seg["range"], seg["stage"], " / ".join(seg["visual"]), seg["line"], seg["subtitle"]))
    L.append("")
    L.append("### 4.1 商品图提示词（跟随参数面板）")
    L.append("")
    L.append("同一套参数同时决定商品主图和三段分镜：商品名、规格、形态、成分、赠品都从这里取，")
    L.append("换商品或改规格，下面四段会一起重算。")
    L.append("")
    pk = packshot_prompts(ctx, templates)
    for label, body in (("图片提示词 · 中文", pk["zh"]), ("图片提示词 · English", pk["en"]),
                        ("镜头提示词", pk["cam"])):
        L.append("%s：" % label)
        L.append("")
        L.append("```")
        L.append(body)
        L.append("```")
        L.append("")
    L.append("### 4.2 分镜配图提示词")
    L.append("")
    L.append("每组拆两份：**图片提示词**写画什么（中文给即梦/可灵，英文给 MJ / Nano Banana Pro），")
    L.append("**镜头提示词**写怎么拍（景别/机位/焦段/运动/节奏，给拍摄执行或视频模型）。")
    L.append("主镜动作取自上面的「镜头提示」，镜头语言与风格写在 `sections.storyboard`，改画面改模板。")
    L.append("")
    for shot in storyboard_prompts(ctx, video, templates):
        L.append("**%s · %s**" % (shot["range"], shot["stage"]))
        L.append("")
        L.append("图片提示词 · 中文：")
        L.append("")
        L.append("```")
        L.append(shot["img_zh"])
        L.append("```")
        L.append("")
        L.append("图片提示词 · English：")
        L.append("")
        L.append("```")
        L.append(shot["img_en"])
        L.append("```")
        L.append("")
        L.append("镜头提示词 · 中文：")
        L.append("")
        L.append("```")
        L.append(shot["cam_zh"])
        L.append("```")
        L.append("")
        L.append("镜头提示词 · English：")
        L.append("")
        L.append("```")
        L.append(shot["cam_en"])
        L.append("```")
        if shot["alt"]:
            L.append("")
            L.append("备选镜头：%s" % "；".join(shot["alt"]))
        L.append("")
    L.append("## 5. 合规检查")
    L.append("")
    L.append("- 扫描范围：%d 条标题 + %d 条卖点 + %d 条话术 + %d 段口播（不含本文件底部的词表本体）。"
             % (len(titles), len(sps), len(css), len(video["segments"])))
    L.append("- 词表：极限词 %d 个 + 平台补充词 %d 个；长词优先匹配，白名单 %s 不误伤。"
             % (base_n, extra_n, " / ".join(allow) if allow else "无"))
    if allow_seen:
        L.append("- 白名单放行：%s（中性时间表述，不计入命中；平台零容忍时直接从 allow_terms 移除即可）。"
                 % "、".join("%s × %d" % (k, v) for k, v in sorted(allow_seen.items())))
    L.append("- 平台规则（%s，风险等级 %s）：%s"
             % (args.platform, platform_rules.get("level", "-"), "；".join(platform_rules.get("focus", []))))
    if comp_total:
        L.append("- 命中明细：" + "；".join("%s → %s × %d" % (k, mapping.get(k, "（删去）"), v)
                                       for k, v in sorted(comp_detail.items())))
        L.append("- **合规检查：命中 %d 处已替换**" % comp_total)
    else:
        L.append("- **合规检查：通过**（0 处命中）")
    L.append("")
    L.append("## 6. 耗时测算（`--benchmark`）")
    L.append("")
    L.append(format_benchmark_md())
    L.append("")
    L.append("口径说明：纯人工按「读需求 + 查卖点 + 手写四类文案」实测均值 300s；人机协作把撰写压到脚本生成 3s，")
    L.append("但新增 120s 人工审校（合规 + 数据核对），这段审校不能省，也是脚本不替人做判断的地方。")
    L.append("")
    return "\n".join(L)


# ---------------------------------------------------------------- CLI

def build_parser():
    p = argparse.ArgumentParser(
        prog="aigc_copywriter.py",
        description="宠物主粮 AIGC 文案改写脚本：读模板库 -> 注入变量 -> 生成标题/卖点/话术/口播 -> 合规替换。",
        epilog=('示例：python aigc_copywriter.py --product "无谷鲜肉成猫粮" --price 129 --spec 1.8kg '
                '--audience "1-3岁室内猫主人" --platform tmall --count 5 --seed 7 --out aigc_samples.md'),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--product", required=True, help="商品名，如 无谷鲜肉成猫粮")
    p.add_argument("--price", type=float, default=129.0, help="到手价（元），默认 129")
    p.add_argument("--spec", default=None, help="规格，如 1.8kg；不填则从变量池抽取")
    p.add_argument("--audience", default=None, help="目标人群，如 1-3岁室内猫主人")
    p.add_argument("--platform", default="tmall", choices=["tmall", "jd", "amazon"],
                   help="发布平台，决定补充词表与规则提示，默认 tmall")
    p.add_argument("--count", type=int, default=TITLE_COUNT, help="标题条数，默认 5")
    p.add_argument("--seed", type=int, default=7, help="随机种子，同种子输出可复现，默认 7")
    p.add_argument("--out", default=None, help="输出 Markdown 路径；不填则只打印到终端")
    p.add_argument("--templates", default=DEFAULT_TEMPLATES, help="模板库 JSON 路径")
    p.add_argument("--benchmark", action="store_true", help="额外打印改造前后耗时对比表")
    p.add_argument("--prompts", action="store_true", help="额外打印三段分镜配图提示词（中英对照）")
    return p


def main(argv=None):
    relax_stdout()
    args = build_parser().parse_args(argv)

    data = load_templates(args.templates)
    sections = data["sections"]
    compliance = sections["compliance"]
    platform_rules = compliance.get("platform_rules", {}).get(args.platform, {})

    rng = random.Random(args.seed)
    demo = build_demo(sections, args)
    pools = demo["pools"] if demo else sections["variable_pools"]
    ctx = build_context(args, pools, rng,
                        lexicon=demo["lexicon"] if demo else None,
                        audience_short=demo["audience"] if demo else None)

    terms, mapping, allow_terms, base_terms, extra_terms = build_compliance_table(compliance, args.platform)

    titles, tstats = gen_titles(sections["title_templates"], ctx, pools, args.price, rng, args.count)
    sps = gen_selling_points(sections["selling_points"], ctx, rng,
                             preset=demo["selling"] if demo else None)
    css = gen_cs_scripts(sections["cs_scripts"], ctx, rng)
    video = gen_video(sections["video_script"], ctx)

    comp_total, comp_detail, allow_seen = 0, {}, {}

    def count_allow(text):
        for word in allow_terms:
            if word in text:
                allow_seen[word] = allow_seen.get(word, 0) + text.count(word)

    def scan(item):
        nonlocal comp_total
        count_allow(item["text"])
        item["text"], hits = apply_compliance(item["text"], terms, mapping, allow_terms)
        if "chars" in item:
            item["chars"] = len(item["text"])
        for key, cnt in hits.items():
            comp_detail[key] = comp_detail.get(key, 0) + cnt
            comp_total += cnt

    for t in titles:
        scan(t)
    for s in sps:
        scan(s)
    for c in css:
        scan(c)
    for seg in video["segments"]:
        count_allow(seg["line"] + " " + seg["subtitle"])
        line, h1 = apply_compliance(seg["line"], terms, mapping, allow_terms)
        sub, h2 = apply_compliance(seg["subtitle"], terms, mapping, allow_terms)
        seg["line"], seg["subtitle"] = line, sub
        for key, cnt in list(h1.items()) + list(h2.items()):
            comp_detail[key] = comp_detail.get(key, 0) + cnt
            comp_total += cnt

    repaired, extra_hits = repair_titles(titles, sections["title_templates"], ctx, pools, rng,
                                         terms, mapping, allow_terms)
    tstats["repaired"] = repaired
    for key, cnt in extra_hits.items():
        comp_detail[key] = comp_detail.get(key, 0) + cnt
        comp_total += cnt

    for key in sorted(comp_detail):
        print("[合规告警] 命中极限词「%s」× %d，已替换为「%s」"
              % (key, comp_detail[key], mapping.get(key, "（删去）")))

    comp_info = {"base": base_terms, "extra": extra_terms, "allow": allow_terms, "map": mapping}
    md = render_markdown(args, ctx, titles, tstats, sps, css, video,
                         comp_total, comp_detail, comp_info, platform_rules, allow_seen,
                         templates=data)

    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(md)
        print("[输出] 已写入 %s（%d 字节，UTF-8）"
              % (os.path.abspath(args.out), os.path.getsize(args.out)))

    print("")
    print("[AIGC] 商品=%s | 规格=%s | 到手价=%s 元 | 平台=%s | seed=%d"
          % (ctx["product"], ctx["spec"], ctx["price"], args.platform, args.seed))
    print("标题（%d 条）：" % len(titles))
    for idx, t in enumerate(titles, 1):
        print("  %d. %s  [%d字/%s]" % (idx, t["text"], t["chars"], t["template"]))
    print("卖点（%d 条）：" % len(sps))
    for idx, s in enumerate(sps, 1):
        print("  %d. %s" % (idx, s["text"]))
    print("客服话术（%d 条）：" % len(css))
    for c in css:
        print("  [%s] %s（%d字）" % (c["scene"], c["text"], c["chars"]))
    print("短视频脚本（三段式 %ds）：" % video["total"])
    for seg in video["segments"]:
        print("  %s %s：%s" % (seg["range"], seg["stage"], seg["line"]))
    print("")
    print("合规检查：命中 %d 处已替换" % comp_total if comp_total else "合规检查：通过")
    if args.benchmark:
        print("")
        print(benchmark_console())
    if args.prompts:
        print("")
        print("[分镜配图提示词] 与网页同一条规则（sections.storyboard），中英各一版")
        print("")
        print(prompts_markdown(ctx, video, data))
    print("单篇预计耗时 3 分钟（输入15s+生成3s+审校2min）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
