import { type ReactNode } from 'react';
import { InfoCircleIcon } from 'tdesign-icons-react';
import { Collapsible } from './Collapsible';

interface FeatureIntroProps {
  title?: string;
  /** 折叠条右侧的简短提示，未展开时也能看到 */
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * 页面顶部「功能说明」折叠区：进入时默认折叠，点击展开显示详细说明。
 * 用详情内容作为 children 传入（建议用 <ul>/<p> 等结构化文本）。
 */
export function FeatureIntro({ title = '功能说明', summary, defaultOpen = false, children }: FeatureIntroProps) {
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      title={
        <>
          <InfoCircleIcon size={18} style={{ color: 'var(--td-brand-color)', flexShrink: 0 }} />
          <span className="text-sm font-semibold" style={{ color: 'var(--td-text-color-primary)' }}>
            {title}
          </span>
          {summary && (
            <span className="text-xs font-normal truncate" style={{ color: 'var(--td-text-color-secondary)' }}>
              {summary}
            </span>
          )}
        </>
      }
    >
      <div className="text-sm space-y-2" style={{ color: 'var(--td-text-color-secondary)' }}>
        {children}
      </div>
    </Collapsible>
  );
}
