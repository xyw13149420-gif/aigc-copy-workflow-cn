/* 分镜提示词引擎：把「参数面板 → 分镜配图」这一步摊开成可复制的提示词。
 *
 * 设计原则和文案那套一致：
 *   - 画面骨架不在这里写死。主镜动作取 video.segments[i].visual[0]（已经按 kind|species 变过），
 *     中文提示词因此天然跟着品类走，改分镜文案不用改这个文件。
 *   - 镜头语言（景别/光/场景/风格/负面词）全部读 copy_templates.json 的 sections.storyboard，
 *     英文版的动作按 kind 单列，因为中文的「捏碎泡软的颗粒」直译成英文模型会画错。
 *   - 输出中英两版：中文给即梦/可灵/中文版 MJ，英文给 Nano Banana Pro / Midjourney。
 *
 * 这个文件不依赖 DOM，命令行（aigc_copywriter.py）与网页用的是同一份 JSON，
 * 所以 --prompts 导出的内容与页面上看到的一字不差。
 */
(function (root) {
  'use strict';

  var ROLE_ORDER = ['hook', 'proof', 'cta'];

  function merge(dst, base, extra) {
    var k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) dst[k] = base[k];
    for (k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) dst[k] = extra[k];
    return dst;
  }

  function roleOf(stage) {
    var s = String(stage || '');
    if (/钩子|开场|hook/i.test(s)) return 'hook';
    if (/促单|转化|收单|下单|cta/i.test(s)) return 'cta';
    return 'proof';
  }

  /* 中文里「三文鱼」翻成 salmon 才能让英文模型画对；
     查不到的成分就不进提示词，宁可少一句，也别塞一个模型看不懂的词 */
  function ingredientEn(name, sb) {
    var map = (sb && sb.ingredient_en) || {};
    var s = String(name || '').trim();
    if (!s) return '';
    if (map[s]) return map[s];
    var keys = Object.keys(map);
    for (var i = 0; i < keys.length; i++) {
      if (s.indexOf(keys[i]) >= 0) return map[keys[i]];
    }
    return '';
  }

  function stageHint(role, ctx, ing) {
    var form = ctx['形态'] || '颗粒';
    var kind = String(ctx.kind || 'dry');
    if (role === 'hook') {
      return '包装与' + form + '要看得清：袋口的纤维、' + form + '落下的轨迹都别糊成一片。';
    }
    if (role === 'cta') {
      var gift = ctx['赠品'] ? '主推装与 ' + ctx['赠品'] + ' 同框，' : '主推装单独陈列，';
      return gift + '右侧留白给价签；包装上的可读文字全部留空，后期再贴。';
    }
    // 猫砂不是拿来吃的，讲「内部结构、湿度」会把人带偏
    if (kind === 'litter') {
      return (ing ? ing + '要看得见：' : '') + '结团后的断面、颗粒完整度、粉尘多少都要拍清楚，别拍成一盆白粉。';
    }
    return (ing ? ing + '的质感要落在画面上：' : '') +
      form + '的内部结构、纤维、湿度都看得见，别拍成一颗塑料模型。';
  }

  function stageHintEn(role, ctx, ing) {
    var kind = String(ctx.kind || 'dry');
    if (role === 'hook') return 'packaging fibres and falling pieces frozen mid-air, honest texture';
    if (role === 'cta') return 'main pack alongside the gift pack, empty right side reserved for a price sticker';
    if (kind === 'litter') return 'clump cross-section, intact pellets, visibly low dust';
    return (ing ? 'visible ' + ing + ' texture, ' : '') +
      'porous cross-section, moisture and fibre readable at a glance';
  }

  /* 分镜文案里混着「价格贴纸弹出」「手指点购物车」这类后期动作，拍不出来。
     提示词要的是能进画面的那一帧，所以先把后期描述滤掉，再取第一条。 */
  var LATE = /弹出|贴纸|字幕|点购物车|点击|打码|留白给/;

  function pickAction(visual, role, ctx) {
    var list = (visual || []).filter(function (v) { return v && !LATE.test(v); });
    if (role === 'cta') {
      // 促单镜优先要静物陈列，而不是手部动作
      var still = list.filter(function (v) { return /陈列|并排|并列|摆放|同框|立着|摆好/.test(v); });
      if (still.length) list = still;
    }
    if (list.length) return { action: list[0], alt: list.slice(1) };
    return {
      action: role === 'cta' ? '主推装与赠品并排陈列在台面上' : (ctx['形态'] || '商品') + '特写',
      alt: [],
    };
  }

  function shotOf(seg, i, ctx, sb) {
    var role = roleOf(seg.stage);
    var kind = String(ctx.kind || 'dry');
    var kinds = sb.kinds || {};
    var k = kinds[kind] || kinds.other || {};
    // 和口播变体同一套查法：先找 kind|species，再用 kind 兜底补缺字段
    var sp = kinds[kind + '|' + String(ctx.species || '')];
    if (sp) {
      k = merge({}, k, sp);
    }
    // 猫砂盆 vs 饭碗：场景允许被品类覆盖，没写就沿用通用场景
    var cam = merge({}, (sb.camera || {})[role] || {}, (k.cam || {})[role] || {});
    var picked = pickAction(seg.visual, role, ctx);
    var action = picked.action;
    var alt = picked.alt;
    var ing = String(ctx['核心成分'] || '').replace(/[+＋]/g, '、');
    var ingEn = ingredientEn(ing, sb);
    var form = ctx['形态'] || '颗粒';
    // 主体带上商品名：换商品（包括自己输入的）时，提示词里能直接看出画的是哪一件，
    // 而不是三段都写一个笼统的「颗粒 / 冻干块」
    var pname = String(ctx.product || ctx['商品名'] || '').trim();
    var subjectZh = role === 'cta'
      ? (pname ? '「' + pname + '」的包装和' + form : '包装和' + form)
      : (pname ? form + '（' + pname + '）' : form);
    var ratio = sb.ratio || '9:16';
    var px = sb.pixels || '1080x1920';

    /* 两组各归各的：
       图片提示词 = 画什么（主体/场景/光线/构图/画幅/风格/不要项），拿去生图；
       镜头提示词 = 怎么拍（景别/机位/焦段/运动/节奏），拿去指导拍摄或喂视频模型。 */
    var imgZh = [
      action + '。',
      '主体：' + subjectZh + '，不是摆拍道具。',
      cam.set_zh ? '场景：' + cam.set_zh : '',
      cam.light_zh ? '光线：' + cam.light_zh : '',
      (cam.shot_zh || cam.frame_zh) ? '构图：' + [cam.shot_zh, cam.frame_zh].filter(Boolean).join('，') : '',
      stageHint(role, ctx, ing),
      '画幅：' + ratio + '（' + px + '）',
      sb.style_zh ? '风格：' + sb.style_zh : '',
      sb.avoid_zh ? '不要：' + sb.avoid_zh : '',
    ].filter(Boolean).join('\n');

    var imgEn = [
      (k[role + '_en'] || k.hook_en || ''),
      k.subject_en || form,
      cam.set_en || '',
      cam.light_en || '',
      [cam.shot_en, cam.frame_en].filter(Boolean).join(', '),
      stageHintEn(role, ctx, ingEn),
      sb.style_en || '',
      pname ? 'product "' + pname + '"' : '',
      ratio + ' vertical, ' + px,
      'no visible face, no text, no logos, clean surfaces',
    ].filter(Boolean).join(', ');

    var camZh = [
      ['景别', cam.shot_zh],
      ['机位', cam.angle_zh],
      ['镜头', cam.lens_zh],
      ['运动', cam.move_zh],
      ['节奏', cam.pace_zh],
    ].filter(function (x) { return x[1]; })
      .map(function (x) { return x[0] + '：' + x[1]; })
      .concat(['时长：' + seg.range + ' · ' + seg.stage])
      .join('\n');

    var camEn = [
      [cam.shot_en, cam.angle_en, cam.lens_en, cam.move_en, cam.pace_en].filter(Boolean).join(', '),
      seg.range + ' (' + role + ')',
    ].filter(Boolean).join(' — ');

    return {
      i: i,
      range: seg.range,
      stage: seg.stage,
      role: role,
      action: action,
      alt: alt,
      title: action.length > 18 ? action.slice(0, 18) + '…' : action,
      img_zh: imgZh,
      img_en: imgEn,
      cam_zh: camZh,
      cam_en: camEn,
      // 旧字段留着，避免别的调用点一次全崩
      zh: imgZh,
      en: imgEn,
      avoid: sb.avoid_zh || '',
      ingredient: ing,
    };
  }

  /* 商品主图：参数面板里选了什么，这张图就画什么。
     商品名/规格/形态/成分/赠品全从 ctx 取，镜头语言从 storyboard.packshot 取，
     所以换商品、改规格、换赠品，这段提示词会跟着变，不需要另写一套。 */
  function packshot(ctx, sb) {
    var board = sb || {};
    var kinds = board.kinds || {};
    var kind = String(ctx.kind || 'dry');
    var k = kinds[kind] || kinds.other || {};
    var sp = kinds[kind + '|' + String(ctx.species || '')];
    if (sp) k = merge({}, k, sp);
    var cam = board.packshot || {};
    var form = ctx['形态'] || '颗粒';
    var gift = String(ctx['赠品'] || '');
    var product = ctx.product || '商品';
    var spec = String(ctx.spec || '');
    var brand = String(ctx.brand || '');
    var ratio = board.ratio || '9:16';
    var px = board.pixels || '1080x1920';
    var side = gift ? '；' + gift + '摆在右侧' : '';

    // 开包动作按品类换：猫砂袋、罐头、零食袋开法都不一样
    var open;
    if (kind === 'wet') open = '罐盖半开，' + form + '在罐前盛进一只白瓷碟' + side;
    else if (kind === 'litter') open = '袋口翻开，' + form + '在袋前堆成一小堆' + side;
    else if (kind === 'treat') open = '袋口撕开一角，' + form + '散在袋前' + side;
    else if (kind === 'dry') open = '袋口微开，' + form + '在袋前堆成一小堆' + side;
    else open = form + '摆在包装前' + side;

    var zh = [
      '主推装：' + product + (brand ? ' · ' + brand : '') + '，' + (spec ? spec + '，' : '') + '正面朝镜头立在台面上。',
      open + '。',
      '· 构图：' + (cam.size_zh || ''),
      '· 光线：' + (cam.light_zh || ''),
      '· 背景：' + (cam.set_zh || ''),
      '包装上的可读文字全部留空，后期再贴；主体是包装和' + form + '，不是摆拍道具。风格：' + (board.style_zh || '') + '。',
      '画幅：' + ratio + '（' + px + '）',
      '不要：' + (board.avoid_zh || ''),
    ].join('\n');

    var en = [
      (k.pack_en || 'the product packaging') + (spec ? ', ' + spec + ' pack' : ''),
      'front facing camera, top slightly open',
      (k.subject_en || form) + ' piled in front',
      gift ? 'a small gift pack standing beside it' : '',
      cam.size_en || '',
      cam.light_en || '',
      cam.set_en || '',
      board.style_en || '',
      ratio + ' vertical, ' + px,
      'no visible face, no text, no logos, clean surfaces',
    ].filter(Boolean).join(', ');

    var camText = [
      '· 景别：' + (cam.size_zh || ''),
      '· 机位：' + (cam.angle_zh || ''),
      '· 光线：' + (cam.light_zh || ''),
      '· 背景：' + (cam.set_zh || ''),
      '· 画幅：' + ratio + '（' + px + '）',
      '· 运动：静态图，无运镜',
    ].filter(function (x) { return x.replace(/^· [^：]+：/, '').trim(); }).join('\n');

    return {
      summary: [product, spec, ctx['核心成分'] || ''].filter(Boolean).join(' · '),
      product: product,
      spec: spec,
      gift: gift,
      zh: zh,
      en: en,
      cam: camText,
    };
  }

  /* ctx 来自引擎（含 形态/核心成分/赠品/spec/price/product/kind/species），
     video 来自引擎的 genVideo 输出 —— 两者都已经按品类适配过 */
  function plan(ctx, video, sb) {
    var board = sb || {};
    var segs = (video && video.segments) || [];
    var shots = segs.map(function (seg, i) { return shotOf(seg, i, ctx, board); });
    var pack = packshot(ctx, board);
    var head = [
      '商品：' + (ctx.product || '') + (ctx.brand ? ' · ' + ctx.brand : ''),
      '参数：' + [ctx.spec, ctx.price ? ctx.price + ' 元' : '', ctx['物种'] || '', ctx['品类'] || '']
        .filter(Boolean).join(' / ') +
        (ctx['场景'] ? ' · 场景 ' + ctx['场景'] : ''),
      '核心成分：' + (ctx['核心成分'] || '未填') + ' / 功能：' + (ctx['功能'] || '未填'),
      '画幅：' + (board.ratio || '9:16') + '（' + (board.pixels || '1080x1920') + '）· 三段共 ' +
        ((video && video.total) || 25) + ' 秒',
    ].join('\n');

    var body = ['', '## 商品图 · 主推装',
      '### 图片提示词', '中文：', pack.zh,
      '', 'English:', pack.en,
      '', '### 镜头提示词', pack.cam]
      .concat(shots.map(function (s) {
        var parts = ['', '## ' + s.range + ' · ' + s.stage,
          '### 图片提示词', '中文：', s.img_zh, '', 'English:', s.img_en,
          '', '### 镜头提示词', '中文：', s.cam_zh, '', 'English:', s.cam_en];
        if (s.alt.length) parts.push('', '备选镜头：' + s.alt.join('；'));
        return parts.join('\n');
      }))
      .join('\n');

    return {
      ratio: board.ratio || '9:16',
      pixels: board.pixels || '1080x1920',
      note: board.note || '',
      shots: shots,
      pack: pack,
      text: head + '\n' + body,
    };
  }

  /* 图片替换的存档键：同一个商品 + 同一套参数才复用上次贴回来的图 */
  function keyOf(ctx) {
    return [ctx.kind || '', ctx.species || '', ctx.product || '', ctx.spec || '']
      .join('|').replace(/\s+/g, '');
  }

  var api = { plan: plan, packshot: packshot, keyOf: keyOf, roleOf: roleOf, ingredientEn: ingredientEn };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.__PROMPTS = api;
})(typeof window !== 'undefined' ? window : globalThis);
