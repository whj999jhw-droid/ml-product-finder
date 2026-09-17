import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, ImageOff, X } from 'lucide-react';

/**
 * 自建图片灯箱。
 *
 * ⚠️ 为什么不用 tdesign 的 ImageViewer：
 *   实测（puppeteer 抓 DOM）它在页面里会残留一个
 *   `.t-image-viewer__trigger--hover` 的半透明块（rgba(0,0,0,.4)，
 *   尺寸撑满父容器 —— 表格里就是 1156×3599），
 *   在浅色主题下看起来就是一大片灰块，而且点不掉。
 *   自建灯箱用 createPortal 挂到 document.body，
 *   点击遮罩 / 右上 × / ESC 都能关，且不会污染页面布局。
 */
export interface LightboxProps {
  images: string[];
  visible: boolean;
  /** 当前下标（受控优先） */
  index?: number;
  /** 兼容 tdesign ImageViewer 的写法 */
  defaultIndex?: number;
  onClose: () => void;
  onIndexChange?: (i: number) => void;
  /** 底部说明文字 */
  caption?: string;
}

export function Lightbox({ images, visible, index, defaultIndex, onClose, onIndexChange, caption }: LightboxProps) {
  const list = images || [];
  const start = index ?? defaultIndex ?? 0;
  const [cur, setCur] = useState(start);
  const [failed, setFailed] = useState<Record<number, boolean>>({});

  useEffect(() => {
    if (visible) {
      setCur(Math.min(Math.max(start, 0), Math.max(list.length - 1, 0)));
      setFailed({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, start, list.length]);

  const go = useCallback(
    (d: number) => {
      if (list.length < 2) return;
      const n = (cur + d + list.length) % list.length;
      setCur(n);
      onIndexChange?.(n);
    },
    [cur, list.length, onIndexChange],
  );

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowLeft') {
        go(-1);
      } else if (e.key === 'ArrowRight') {
        go(1);
      }
    };
    window.addEventListener('keydown', onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prev;
    };
  }, [visible, go, onClose]);

  if (!visible || !list.length) return null;
  const src = list[Math.min(Math.max(cur, 0), list.length - 1)];

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/85 select-none"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      {/* 关闭 */}
      <button
        type="button"
        className="absolute top-3 right-4 z-[2] w-9 h-9 rounded-full bg-white/15 hover:bg-white/30 text-white flex items-center justify-center"
        title="关闭（ESC）"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <X size={18} />
      </button>

      {/* 计数 */}
      {list.length > 1 && (
        <div className="absolute top-4 left-4 z-[2] text-white/80 text-xs px-2 py-1 rounded bg-white/10">
          {cur + 1} / {list.length}
        </div>
      )}

      {/* 左右切换 */}
      {list.length > 1 && (
        <>
          <button
            type="button"
            className="absolute left-3 z-[2] w-10 h-10 rounded-full bg-white/15 hover:bg-white/30 text-white flex items-center justify-center"
            title="上一张（←）"
            onClick={(e) => {
              e.stopPropagation();
              go(-1);
            }}
          >
            <ChevronLeft size={22} />
          </button>
          <button
            type="button"
            className="absolute right-3 z-[2] w-10 h-10 rounded-full bg-white/15 hover:bg-white/30 text-white flex items-center justify-center"
            title="下一张（→）"
            onClick={(e) => {
              e.stopPropagation();
              go(1);
            }}
          >
            <ChevronRight size={22} />
          </button>
        </>
      )}

      {failed[cur] ? (
        <div className="text-white/80 text-sm flex flex-col items-center gap-2">
          <ImageOff size={28} />
          <div>图片加载失败</div>
          <div className="text-[11px] text-white/50 max-w-[70vw] break-all text-center">{src}</div>
        </div>
      ) : (
        <img
          src={src}
          alt=""
          referrerPolicy="no-referrer"
          className="max-w-[94vw] max-h-[92vh] object-contain shadow-2xl"
          onClick={(e) => e.stopPropagation()}
          onError={() => setFailed((f) => ({ ...f, [cur]: true }))}
        />
      )}

      {caption && (
        <div className="absolute bottom-4 left-0 right-0 text-center text-white/70 text-xs px-6 truncate">{caption}</div>
      )}
    </div>,
    document.body,
  );
}

/** 便捷 hook：把常用的三件套（images/index/visible）收敛到一处 */
export function useLightbox() {
  const [state, setState] = useState<{ visible: boolean; images: string[]; index: number }>({
    visible: false,
    images: [],
    index: 0,
  });
  const openLightbox = useCallback((images: string[], index = 0) => {
    const valid = (images || []).filter(Boolean);
    if (!valid.length) return;
    setState({ visible: true, images: valid, index: Math.min(Math.max(index, 0), valid.length - 1) });
  }, []);
  const closeLightbox = useCallback(() => setState((s) => ({ ...s, visible: false })), []);
  return { ...state, openLightbox, closeLightbox };
}
