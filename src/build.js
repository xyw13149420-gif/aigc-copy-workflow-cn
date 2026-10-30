// 把模板库 + 分镜配图 + 引擎 + 页面模板拼装成页面
// 两个产物：
//   aigc_workflow.html  —— 资源全部 base64 内嵌，单文件可离线分发（纯本地模板引擎）
//   public/index.html   —— 资源走相对路径，由 node 静态服务托管，接云服务（商品库 / 模型 / 记录）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const tpl = fs.readFileSync(path.join(__dirname, 'page.template.html'), 'utf8');
const engine = fs.readFileSync(path.join(__dirname, 'engine.js'), 'utf8');
const facets = fs.readFileSync(path.join(__dirname, 'facets.js'), 'utf8');
const post = fs.readFileSync(path.join(__dirname, 'postprocess.js'), 'utf8');
const prompts = fs.readFileSync(path.join(__dirname, 'prompts.js'), 'utf8');
const skin = fs.readFileSync(path.join(__dirname, 'skin.css'), 'utf8');
const ui = fs.readFileSync(path.join(__dirname, 'ui.css'), 'utf8');
const data = fs.readFileSync(path.join(root, 'copy_templates.json'), 'utf8');

const shotDir = path.join(root, 'assets', 'storyboard');
const filmDir = path.join(root, 'assets', 'video', 'web');
const SITE_DIR = path.join(root, 'public');
const CLOUD_CFG = path.join(root, 'cloud.config.json');

/* 内置样张只对得上某个「品类|物种」时才拿来做示例：
   狗粮的文案配一张猫粮图，比空着更假。kinds 决定这张图能贴给谁。 */
// shot 字段说明这张样张拍的是什么动作，页面据此把图和文案配到一起：
// 老记录（文案还是旧版本）里「倒出主粮」排在第二段时，倒粮这张图会跟着过去，不会张冠李戴
const SHOTS = [
  { file: 'web-01.jpg', range: '0-3s', stage: '钩子', note: '撕开袋口，颗粒落进玻璃碗', kinds: ['dry|猫'], role: 'hook', shot: 'pour' },
  { file: 'web-02.jpg', range: '3-15s', stage: '卖点证明', note: '捏碎泡软的颗粒，看内部结构', kinds: ['dry|猫'], role: 'proof', shot: 'pinch' },
  { file: 'web-03.jpg', range: '15-25s', stage: '促单', note: '主袋与赠品陈列，右侧留贴纸位', kinds: ['dry|猫'], role: 'cta', shot: 'pack' },
];
const FILM = { file: 'film-25s.mp4', poster: 'poster-film.jpg', total: '25.2s', chapters: [0, 5.06, 15.1] };

const b64 = (f, mime) => `data:${mime};base64,` + fs.readFileSync(f).toString('base64');

function storyboard(mode) {
  if (!fs.existsSync(shotDir)) return '[]';
  const list = SHOTS.filter((s) => fs.existsSync(path.join(shotDir, s.file))).map((s) => ({
    range: s.range,
    stage: s.stage,
    note: s.note,
    kinds: s.kinds || [],
    role: s.role || '',
    shot: s.shot || '',
    src: mode === 'inline'
      ? b64(path.join(shotDir, s.file), 'image/jpeg')
      : 'assets/storyboard/' + s.file,
  }));
  return JSON.stringify(list);
}

function film(mode) {
  if (!fs.existsSync(path.join(filmDir, FILM.file))) return 'null';
  return JSON.stringify({
    src: mode === 'inline'
      ? b64(path.join(filmDir, FILM.file), 'video/mp4')
      : 'assets/video/web/' + FILM.file,
    poster: fs.existsSync(path.join(filmDir, FILM.poster))
      ? (mode === 'inline' ? b64(path.join(filmDir, FILM.poster), 'image/jpeg') : 'assets/video/web/' + FILM.poster)
      : '',
    total: FILM.total,
    chapters: FILM.chapters,
  });
}

/* 云服务配置：只从 cloud.config.json 读（开通时返回的 publicConfig），不在代码里硬编码 */
function cloudConfig() {
  if (!fs.existsSync(CLOUD_CFG)) return null;
  const raw = JSON.parse(fs.readFileSync(CLOUD_CFG, 'utf8'));
  if (!raw.endpoint || !raw.publishableKey) return null;
  return {
    endpoint: raw.endpoint,
    oauthRelayBaseUrl: raw.oauthRelayBaseUrl || '',
    publishableKey: raw.publishableKey,
  };
}

/* 线上静态资源里 index.html 是 no-cache，app.js 却被托管方标了 max-age=604800。
   只要 HTML 更新而 app.js 还留在浏览器缓存里，就会出现「新页面 + 旧脚本」：
   旧脚本按老 DOM 找节点、找不到就中断，下拉和生成会一起失灵。
   这里把脚本内容的指纹拼进 URL，脚本一变地址就变，缓存自动作废。 */
function appVersion() {
  const src = fs.readFileSync(path.join(__dirname, 'app.js'));
  return crypto.createHash('md5').update(src).digest('hex').slice(0, 10);
}

function appTag(mode) {
  if (mode !== 'site') return '';
  const cfg = cloudConfig();
  const lines = [
    '<script src="https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js"></script>',
  ];
  if (!cfg) {
    console.warn('! cloud.config.json 缺失，站点版将无法连接云服务');
    lines.push('<script>window.CLOUD_CONFIG = null;</script>');
  } else {
    lines.push('<script>window.CLOUD_CONFIG = ' + JSON.stringify(cfg) + ';</script>');
  }
  lines.push('<script src="app.js?v=' + appVersion() + '"></script>');
  return lines.join('\n');
}

function compose(mode) {
  return tpl
    .replace('/*__DATA__*/', () => data)
    .replace('/*__STORYBOARD__*/', () => storyboard(mode))
    .replace('/*__FILM__*/', () => film(mode))
    .replace('/*__ENGINE__*/', () => engine)
    .replace('/*__FACETS__*/', () => facets)
    .replace('/*__PROMPTS__*/', () => prompts)
    .replace('/*__POST__*/', () => post)
    .replace('/*__APP_TAG__*/', () => appTag(mode))
    .replace(/__MODE__/g, mode)
    /* 皮肤层最后合入：它只覆盖颜色/圆角/阴影，必须排在原样式之后 */
    .replace('</style>', () => skin + '\n' + ui + '\n</style>');
}

/* ---------------------------------------------------------- 单文件版 */
const inlineHtml = compose('inline');
fs.writeFileSync(path.join(root, 'aigc_workflow.html'), inlineHtml, 'utf8');

/* ---------------------------------------------------------- 站点版 */
function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

fs.mkdirSync(SITE_DIR, { recursive: true });
const siteHtml = compose('site');
fs.writeFileSync(path.join(SITE_DIR, 'index.html'), siteHtml, 'utf8');

// 静态资源：分镜图、成片、封面
let copied = 0;
for (const s of SHOTS) {
  const from = path.join(shotDir, s.file);
  if (fs.existsSync(from)) {
    copyFile(from, path.join(SITE_DIR, 'assets', 'storyboard', s.file));
    copied++;
  }
}
for (const f of [FILM.file, FILM.poster]) {
  const from = path.join(filmDir, f);
  if (fs.existsSync(from)) {
    copyFile(from, path.join(SITE_DIR, 'assets', 'video', 'web', f));
    copied++;
  }
}
copyFile(path.join(__dirname, 'app.js'), path.join(SITE_DIR, 'app.js'));

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
const cfg = cloudConfig();
console.log('单文件版 aigc_workflow.html', kb(inlineHtml.length), '（离线，纯本地引擎）');
console.log('站点版   public/index.html', kb(siteHtml.length), '| 静态资源', copied, '个 | app.js 已复制');
console.log('云服务   ', cfg ? cfg.endpoint : '未配置');
