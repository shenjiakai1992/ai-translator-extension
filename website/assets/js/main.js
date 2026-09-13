/**
 * 宣传站交互脚本：顶栏阴影、移动端导航、入场动画、代码复制。
 * 原生实现，无任何第三方依赖。
 */

(() => {
  'use strict';

  /** 滚动超过该像素后给顶栏加分隔阴影 */
  const SCROLL_THRESHOLD_PX = 8;
  /** 元素露出多少比例时触发入场动画 */
  const REVEAL_VISIBLE_RATIO = 0.15;
  /** 复制按钮成功反馈的持续时长 */
  const COPY_FEEDBACK_MS = 1600;
  /** 移动端断点，需与 components.css 中的媒体查询保持一致 */
  const MOBILE_MAX_PX = 768;

  /** 顶栏滚动状态 */
  const initHeaderShadow = () => {
    const header = document.getElementById('site-header');
    if (!header) return;

    const syncShadow = () => {
      header.classList.toggle('is-scrolled', window.scrollY > SCROLL_THRESHOLD_PX);
    };

    syncShadow();
    window.addEventListener('scroll', syncShadow, { passive: true });
  };

  /** 移动端导航展开 / 收起 */
  const initNavToggle = () => {
    const toggle = document.getElementById('nav-toggle');
    const nav = document.getElementById('site-nav');
    if (!toggle || !nav) return;

    const setOpen = (isOpen) => {
      toggle.setAttribute('aria-expanded', String(isOpen));
      nav.classList.toggle('is-open', isOpen);
    };

    const close = () => setOpen(false);

    toggle.addEventListener('click', () => {
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });

    // 点击导航项后收起，避免移动端菜单挡住内容
    nav.addEventListener('click', (event) => {
      if (event.target.closest('a')) close();
    });

    // 点空白处或按 Esc 也能收起
    document.addEventListener('click', (event) => {
      if (window.innerWidth > MOBILE_MAX_PX) return;
      if (!nav.contains(event.target) && !toggle.contains(event.target)) close();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
    });

    // 从移动端尺寸切回桌面端时，清掉可能残留的展开态
    window.addEventListener('resize', () => {
      if (window.innerWidth > MOBILE_MAX_PX) close();
    });
  };

  /** 元素进入视口时淡入 */
  const initReveal = () => {
    const targets = document.querySelectorAll('.reveal');
    if (targets.length === 0) return;

    // 浏览器不支持 IntersectionObserver 时直接显示，保证内容可见
    if (!('IntersectionObserver' in window)) {
      targets.forEach((node) => node.classList.add('is-visible'));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        });
      },
      { threshold: REVEAL_VISIBLE_RATIO }
    );

    targets.forEach((node) => observer.observe(node));
  };

  /** 代码块复制按钮 */
  const initCopyButtons = () => {
    const buttons = document.querySelectorAll('[data-copy-target]');
    if (buttons.length === 0) return;

    buttons.forEach((button) => {
      button.addEventListener('click', async () => {
        const source = document.getElementById(button.dataset.copyTarget);
        if (!source) return;

        const text = source.textContent.trim();
        const original = button.textContent;

        try {
          await navigator.clipboard.writeText(text);
          button.textContent = '已复制 ✓';
        } catch {
          // 剪贴板不可用时退回到选中文本，让用户手动复制
          button.textContent = '请手动复制';
        }

        window.setTimeout(() => {
          button.textContent = original;
        }, COPY_FEEDBACK_MS);
      });
    });
  };

  const init = () => {
    initHeaderShadow();
    initNavToggle();
    initReveal();
    initCopyButtons();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
