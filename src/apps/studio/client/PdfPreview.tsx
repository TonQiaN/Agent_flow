import { useEffect, useRef, useState } from 'react';
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
  type RenderTask,
} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
GlobalWorkerOptions.workerSrc = workerUrl;
/** Render locally without relying on a browser PDF plug-in or executing document actions. */
export default function PdfPreview({
  url,
  name,
}: {
  url: string;
  name: string;
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>(),
    [page, setPage] = useState(1),
    [error, setError] = useState(''),
    [text, setText] = useState(''),
    [ready, setReady] = useState(false),
    [width, setWidth] = useState(600);
  const container = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const observer = new ResizeObserver((entries) =>
      setWidth(Math.max(180, Math.floor(entries[0].contentRect.width))),
    );
    observer.observe(container.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let active = true;
    setPdf(undefined);
    setPage(1);
    setError('');
    setReady(false);
    const task = getDocument({ url, enableXfa: false });
    task.promise
      .then((pdf) => {
        if (active) setPdf(pdf);
      })
      .catch((e) => {
        if (active) setError('PDF 无法读取：' + e.message);
      });
    return () => {
      active = false;
      void task.destroy();
    };
  }, [url]);
  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let active = true,
      render: RenderTask | undefined;
    setReady(false);
    setError('');
    setText('');
    pdf
      .getPage(page)
      .then(async (source) => {
        if (!active) return;
        const viewport = source.getViewport({
            scale:
              Math.min(width, 1100) / source.getViewport({ scale: 1 }).width,
          }),
          scale = Math.min(window.devicePixelRatio || 1, 2),
          target = canvas.current!;
        target.width = Math.floor(viewport.width * scale);
        target.height = Math.floor(viewport.height * scale);
        target.style.width = '100%';
        target.style.height = 'auto';
        render = source.render({
          canvas: target,
          viewport,
          transform: [scale, 0, 0, scale, 0, 0],
        });
        await render.promise;
        if (active) {
          setReady(true);
          const content = await source.getTextContent();
          if (active)
            setText(
              content.items
                .map((item) => ('str' in item ? item.str : ''))
                .join(' '),
            );
        }
      })
      .catch((e) => {
        if (active && e.name !== 'RenderingCancelledException')
          setError('PDF 页面无法显示：' + e.message);
      });
    return () => {
      active = false;
      render?.cancel();
    };
  }, [pdf, page, width]);
  return (
    <div ref={container} className="pdf-preview">
      <div className="pdf-toolbar">
        <button
          className="secondary"
          disabled={!pdf || page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          上一页
        </button>
        <span>{pdf ? `第 ${page} / ${pdf.numPages} 页` : '正在读取 PDF…'}</span>
        <button
          className="secondary"
          disabled={!pdf || page >= pdf.numPages}
          onClick={() => setPage((p) => p + 1)}
        >
          下一页
        </button>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {!ready && !error && <p role="status">正在显示页面…</p>}
      <canvas
        ref={canvas}
        role="img"
        aria-label={`${name} 第 ${page} 页`}
        data-ready={ready}
      />
      {text && (
        <details>
          <summary>查看本页文字</summary>
          <p className="pdf-text">{text}</p>
        </details>
      )}
    </div>
  );
}
