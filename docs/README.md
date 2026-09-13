# AI 翻译助手 · 官方宣传站

插件的静态宣传页，纯 HTML + CSS + 原生 JS，**零依赖、零构建**，直接双击 `index.html` 就能看。

## 目录结构

```
docs/
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
cd docs
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

## 部署到 GitHub Pages（已完成）

**线上地址：https://shenjiakai1992.github.io/ai-translator-extension/**

已配置为从 `main` 分支的 `/docs` 目录发布，**推送到 main 后会自动重新部署**，
无需任何额外操作，通常 1~2 分钟生效。

> 为什么目录叫 `docs` 而不是 `website`？因为 GitHub Pages 的「从分支发布」只接受
> 仓库根目录 `/` 或 `/docs` 两个路径。叫 `docs` 是 Pages 的通用约定，也省掉了一套 CI 工作流。

以后要改：

| 操作 | 做法 |
| --- | --- |
| 换发布目录 | 仓库 → Settings → Pages → Source 改目录 |
| 关掉站点 | 同上，Source 选 `None` |
| 看构建状态 | 仓库 → Actions 里的 `pages-build-deployment`，或 Settings → Pages |
| 绑定自定义域名 | Settings → Pages → Custom domain（需在域名服务商加 CNAME 解析） |

如果想把站点独立出去，也可以把 `docs/` 的内容推到一个单独的公开仓库
（仓库名建议 `<用户名>.github.io`，访问地址会更短），再按同样方式开启 Pages。

## 改内容要动哪里

| 想改什么 | 改哪个文件 |
| --- | --- |
| 文案、功能描述、安装步骤、FAQ | `index.html` |
| 品牌色、字号、间距、圆角 | `assets/css/variables.css` |
| 某个组件的外观（按钮/卡片/演示窗口） | `assets/css/components.css` |
| 交互行为（导航、动画、复制） | `assets/js/main.js` |

改颜色只需要动 `variables.css` 里的变量，别在组件里写死色值。

## ⚠️ 上线前必须处理的一件事

页面里的 `git clone` 命令与仓库链接指向 `shenjiakai1992/ai-translator-extension`。
该仓库已于 2026/09/13 转为**公开**，访客可以正常访问，**此项已确认无问题**。

若将来该仓库改回私有，记得同步处理这里，否则访客点开只会看到 404。
