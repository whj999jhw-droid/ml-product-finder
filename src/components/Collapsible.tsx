import { useState, type ReactNode } from 'react';
import { ChevronDownIcon } from 'tdesign-icons-react';

interface CollapsibleProps {
  title: ReactNode;
  defaultOpen?: boolean;
  /** header 右侧内容（如简短副标题/状态标签） */
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * 通用折叠容器：默认折叠，点击 header 展开/收起。
 * 用于顶部「功能说明」与页面内「高级选项」等需要节省空间的场景。
 */
export function Collapsible({ title, defaultOpen = false, right, children, className }: CollapsibleProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      className={className}
      style={{
        borderRadius: 8,
        border: '1px solid var(--td-component-border)',
        background: 'var(--td-bg-color-container)',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left select-none"
        style={{ cursor: 'pointer' }}
      >
        <span className="flex-1 min-w-0 flex items-center gap-2">{title}</span>
        {right}
        <ChevronDownIcon
          size={16}
          style={{
            color: 'var(--td-text-color-placeholder)',
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.2s',
            flexShrink: 0,
          }}
        />
      </button>
      {open && (
        <div className="px-4 pb-4 pt-1" style={{ borderTop: '1px solid var(--td-component-border)' }}>
          {children}
        </div>
      )}
    </div>
  );
}
