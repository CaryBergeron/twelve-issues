// Pulls plain text out of uploaded files in the browser, so files never need to be stored.
// Libraries load only when needed: PDF.js for PDF, Mammoth for DOCX, JSZip for EPUB.
const Extract = (() => {
  const CDN = {
    pdf: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs',
    pdfWorker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs',
    mammoth: 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js',
    jszip: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
  };
  const loaded = {};
  function loadScript(src) {
    if (!loaded[src]) loaded[src] = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load the file reader. Check your connection and try again.'));
      document.head.appendChild(s);
    });
    return loaded[src];
  }

  const clean = t => t.replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  async function pdf(file) {
    const lib = await import(CDN.pdf);
    lib.GlobalWorkerOptions.workerSrc = CDN.pdfWorker;
    const doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map(it => it.str + (it.hasEOL ? '\n' : ' ')).join(''));
    }
    return pages.join('\n\n');
  }

  async function docx(file) {
    await loadScript(CDN.mammoth);
    const r = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return r.value;
  }

  async function epub(file) {
    await loadScript(CDN.jszip);
    const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
    const container = await zip.file('META-INF/container.xml')?.async('text');
    const opfPath = container?.match(/full-path="([^"]+)"/)?.[1];
    const parser = new DOMParser();
    let order = [];
    if (opfPath) {
      const opf = parser.parseFromString(await zip.file(opfPath).async('text'), 'application/xml');
      const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
      const items = Object.fromEntries([...opf.querySelectorAll('manifest > item')].map(i => [i.getAttribute('id'), i.getAttribute('href')]));
      order = [...opf.querySelectorAll('spine > itemref')].map(r => base + decodeURIComponent(items[r.getAttribute('idref')] || ''));
    } else {
      order = Object.keys(zip.files).filter(n => /\.x?html?$/i.test(n)).sort();
    }
    const parts = [];
    for (const path of order) {
      const f = zip.file(path);
      if (!f) continue;
      const doc = parser.parseFromString(await f.async('text'), 'text/html');
      parts.push(doc.body ? doc.body.innerText || doc.body.textContent : '');
    }
    return parts.join('\n\n');
  }

  async function text(file) { return await file.text(); }

  async function fromFile(file) {
    const name = file.name.toLowerCase();
    let out;
    if (name.endsWith('.pdf')) out = await pdf(file);
    else if (name.endsWith('.docx')) out = await docx(file);
    else if (name.endsWith('.epub')) out = await epub(file);
    else if (/\.(txt|md|markdown|csv|html?|rtf)$/.test(name)) out = await text(file);
    else throw new Error(`${file.name}: use PDF, DOCX, EPUB, or TXT files.`);
    if (name.match(/\.html?$/)) out = new DOMParser().parseFromString(out, 'text/html').body?.textContent || out;
    return clean(out);
  }

  return { fromFile, accept: '.pdf,.docx,.epub,.txt,.md,.csv,.html,.htm' };
})();
