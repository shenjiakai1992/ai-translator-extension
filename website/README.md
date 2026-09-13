# AI 翻译助手 · 官方宣传站

插件的静态宣传页，纯 HTML + CSS + 原生 JS，**零依赖、零构建**，直接双击 `index.html` 就能看。

## 目录结构

```
website/
├── index.html                  # 单页站点
└── assets/
    ├── css/
    │   ├── variables.css       # 设计令牌（颜色/字号/间距/层级）
    │   ├── base.css            # 重置、排版、布局骨架、工具类
    │   └── components.css      # 各组件样式（导航/按钮/演示/步骤/FAQ…）
    ├── js/
    │   └── main.js             # 顶栏阴影、移动端导航、入场动画、复制按钮
    └── img/
        ├── favicon.png
        └── icon-128.png
```

## 本地预览

直接双击 `index.html` 即可。若想更接近线上环境（相对路径、缓存行为一致），起个本地服务：

```bash
cd website
python3 -m http.server 8080
# 打开 http://127.0.0.1:8080
```

## 自动化验证

```bash
npm run test:site
```

会用真实浏览器检查：资源是否 404、有无控制台报错、桌面端与手机端（375px）是否出现横向滚动、
移动端导航展开收起、锚点是否失效、内容是否完整、是否符合前端规范（无行内样式、类名短斜线、
语义化标签、装饰图有替代文本），并输出桌面端 / 手机端 / 整页截图到 `tests/output/`。

## 部署到 GitHub Pages

站点是纯静态文件，推荐用 Pages 部署。两种方式：

**方式一：仓库设置里选目录（最简单）**

1. 仓库 → Settings → Pages
2. Source 选 `Deploy from a branch`
3. Branch 选 `main`，目录选 `/website`，保存
4. 等一两分钟，访问 `https://<用户名>.github.io/<仓库名>/`

**方式二：单独建一个公开仓库放站点**

如果插件仓库要保持私有，把 `website/` 的内容单独推到一个公开仓库，
再按上面的方式开启 Pages。仓库名建议 `<用户名>.github.io`，访问地址会更短。

## 改内容要动哪里

| 想改什么 | 改哪个文件 |
| --- | --- |
| 文案、功能描述、安装步骤、FAQ | `index.html` |
| 品牌色、字号、间距、圆角 | `assets/css/variables.css` |
| 某个组件的外观（按钮/卡片/演示窗口） | `assets/css/components.css` |
| 交互行为（导航、动画、复制） | `assets/js/main.js` |

改颜色只需要动 `variables.css` 里的变量，别在组件里写死色值。

## ⚠️ 上线前必须处理的一件事

页面里的 **`git clone` 命令与仓库链接指向的是私有仓库** `shenjiakai1992/ai-translator-extension`，
未登录的访客点开只会看到 404。上线前二选一：

- 把插件仓库改为公开；
- 或把页面里的安装步骤改成「下载 ZIP 包」并给出可公开访问的下载地址。

（本地自用或只发给自己的话，可以忽略这条。）
