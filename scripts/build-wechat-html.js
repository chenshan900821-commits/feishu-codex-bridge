'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const inputPath = path.join(root, 'docs', 'articles', 'wechat-feishu-codex-bridge.md');
const outputPath = path.join(root, 'docs', 'articles', 'wechat-copy.html');
const articleDir = path.dirname(inputPath);

const styles = {
  h1: 'margin:0 0 22px;font-size:28px;line-height:1.35;font-weight:800;color:#111827;letter-spacing:0;',
  h2: 'margin:34px 0 14px;padding-left:12px;border-left:4px solid #2f6bff;font-size:22px;line-height:1.45;font-weight:800;color:#111827;letter-spacing:0;',
  h3: 'margin:28px 0 12px;font-size:18px;line-height:1.5;font-weight:800;color:#111827;letter-spacing:0;',
  p: 'margin:14px 0;font-size:16px;line-height:1.86;color:#374151;letter-spacing:0;',
  ul: 'margin:14px 0 18px;padding-left:22px;color:#374151;',
  li: 'margin:6px 0;font-size:16px;line-height:1.75;color:#374151;',
  pre: 'box-sizing:border-box;margin:16px 0;padding:14px 16px;border-radius:8px;background:#111827;overflow:auto;white-space:pre-wrap;',
  code: 'font-family:Menlo,Consolas,Monaco,monospace;font-size:13px;line-height:1.72;color:#e5e7eb;',
  inlineCode: 'font-family:Menlo,Consolas,Monaco,monospace;background:#f1f5f9;color:#1f2937;border-radius:4px;padding:1px 5px;font-size:90%;',
  figure: 'margin:22px 0;text-align:center;',
  img: 'display:block;width:100%;height:auto;border-radius:10px;border:1px solid #e5e7eb;',
  caption: 'margin-top:8px;font-size:13px;line-height:1.5;color:#6b7280;text-align:center;',
};

const source = fs.readFileSync(inputPath, 'utf8');
const publicSource = source.split(/\n## 公众号配图说明\b/)[0].trim();
const articleHtml = markdownToWechatHtml(publicSource);

const fullHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>公众号复制版 - Feishu Codex Bridge</title>
</head>
<body style="margin:0;background:#f6f8fb;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;">
  <div style="position:sticky;top:0;z-index:10;background:#111827;color:#fff;padding:14px 18px;box-shadow:0 8px 24px rgba(17,24,39,.16);">
    <button id="copyButton" style="border:0;border-radius:8px;background:#2f6bff;color:#fff;font-size:15px;font-weight:700;padding:10px 14px;cursor:pointer;">复制正文到剪贴板</button>
    <span id="copyStatus" style="margin-left:12px;font-size:14px;color:#d1d5db;">复制后直接粘贴到微信公众号编辑器。图片已内嵌，不依赖本地路径。</span>
  </div>
  <main id="article" style="box-sizing:border-box;max-width:760px;margin:0 auto;background:#fff;padding:34px 24px 56px;line-height:1.82;">
${articleHtml}
  </main>
  <script>
    const button = document.getElementById('copyButton');
    const status = document.getElementById('copyStatus');
    button.addEventListener('click', async () => {
      const article = document.getElementById('article');
      const html = article.innerHTML;
      const text = article.innerText;
      try {
        if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
          await navigator.clipboard.write([
            new ClipboardItem({
              'text/html': new Blob([html], { type: 'text/html' }),
              'text/plain': new Blob([text], { type: 'text/plain' })
            })
          ]);
        } else {
          const range = document.createRange();
          range.selectNodeContents(article);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          document.execCommand('copy');
          selection.removeAllRanges();
        }
        status.textContent = '已复制。现在去微信公众号编辑器粘贴。';
      } catch (error) {
        status.textContent = '浏览器阻止自动复制：请选中正文区域后 Ctrl+C。';
      }
    });
  </script>
</body>
</html>
`;

fs.writeFileSync(outputPath, fullHtml, 'utf8');
console.log(`Wrote ${outputPath}`);

function markdownToWechatHtml(markdown) {
  const lines = markdown.split(/\r?\n/);
  const html = [];
  let paragraph = [];
  let list = [];
  let code = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p style="${styles.p}">${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!list.length) return;
    html.push(`<ul style="${styles.ul}">${list.map((item) => `<li style="${styles.li}">${inline(item)}</li>`).join('')}</ul>`);
    list = [];
  };

  const flushCode = () => {
    if (!code) return;
    html.push(`<pre style="${styles.pre}"><code style="${styles.code}">${escapeHtml(code.lines.join('\n'))}</code></pre>`);
    code = null;
  };

  for (const line of lines) {
    const codeFence = line.match(/^```/);
    if (codeFence && code) {
      flushCode();
      continue;
    }
    if (codeFence) {
      flushParagraph();
      flushList();
      code = { lines: [] };
      continue;
    }
    if (code) {
      code.lines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const image = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (image) {
      flushParagraph();
      flushList();
      html.push(imageHtml(image[1], image[2]));
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      const style = level === 1 ? styles.h1 : level === 2 ? styles.h2 : styles.h3;
      html.push(`<h${level} style="${style}">${inline(heading[2])}</h${level}>`);
      continue;
    }

    const listItem = line.match(/^-\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      list.push(listItem[1]);
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  flushCode();
  return html.map((line) => `    ${line}`).join('\n');
}

function imageHtml(alt, relativePath) {
  const imagePath = path.resolve(articleDir, relativePath);
  const ext = path.extname(imagePath).toLowerCase();
  const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
  const encoded = fs.readFileSync(imagePath).toString('base64');
  const src = `data:${mime};base64,${encoded}`;
  const safeAlt = escapeHtml(alt || '');
  return `<figure style="${styles.figure}"><img src="${src}" alt="${safeAlt}" style="${styles.img}"><figcaption style="${styles.caption}">${safeAlt}</figcaption></figure>`;
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, `<code style="${styles.inlineCode}">$1</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
