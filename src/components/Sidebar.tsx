import { Button, Tooltip } from 'tdesign-react';
import { AddIcon, DeleteIcon, InboxIcon, NotificationIcon, ToolsIcon } from 'tdesign-icons-react';
import { confirmDialog } from '../utils/dialog';
import { Bot, ShoppingBag, Flame } from 'lucide-react';
import { APP_CONFIG } from '../config';
import { Session, Agent } from '../types';
import { ICON_MAP } from '../utils/iconMap';

interface SidebarProps {
  sessions: Session[];
  currentSessionId: string | null;
  isSettingsPage: boolean;
  isProductsPage?: boolean;
  isSourcingPage?: boolean;
  isListingPage?: boolean;
  isStoresPage?: boolean;
  isOrdersPage?: boolean;
  isNotificationsPage?: boolean;
  isTrendsPage?: boolean;
  isProductAdminPage?: boolean;
  isCandidatesPage?: boolean;
  isConfigPage?: boolean;
  isMiaoshouBoxPage?: boolean;
  isMobile?: boolean;
  sidebarOpen: boolean;
  agents: Agent[];
  getAgent: (id: string) => Agent | undefined;
  onNewChat: () => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onOpenProducts: () => void;
  onOpenSourcing: () => void;
  onOpenListing: () => void;
  onOpenOrders?: () => void;
  onOpenTrends?: () => void;
  onOpenProductAdmin?: () => void;
  onOpenCandidates?: () => void;
  onOpenConfig?: () => void;
  onOpenMiaoshouBox?: () => void;
}

export function Sidebar({
  sessions,
  currentSessionId,
  isSettingsPage,
  isProductsPage,
  isSourcingPage,
  isListingPage,
  isStoresPage,
  isOrdersPage,
  isNotificationsPage,
  isTrendsPage,
  isProductAdminPage,
  isCandidatesPage,
  isConfigPage,
  isMiaoshouBoxPage,
  isMobile,
  sidebarOpen,
  agents,
  getAgent,
  onNewChat,
  onSelectSession,
  onDeleteSession,
  onOpenProducts,
  onOpenSourcing,
  onOpenListing,
  onOpenOrders,
  onOpenTrends,
  onOpenProductAdmin,
  onOpenCandidates,
  onOpenConfig,
  onOpenMiaoshouBox,
}: SidebarProps) {
  return (
    <aside 
      className={`${isMobile ? 'fixed top-0 left-0 z-40 h-[100dvh]' : 'flex-shrink-0'} flex flex-col transition-all duration-300 overflow-hidden`}
      style={{ 
        width: isMobile ? 260 : (sidebarOpen ? 260 : 0),
        transform: isMobile && !sidebarOpen ? 'translateX(-100%)' : 'translateX(0)',
        backgroundColor: 'var(--td-bg-color-container)'
      }}
    >
      {/* Logo */}
      <div className="h-14 px-4 flex items-center flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div 
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ backgroundColor: 'var(--td-brand-color)' }}
          >
            <span className="text-white text-sm font-bold">{APP_CONFIG.nameInitial}</span>
          </div>
          <span 
            className="text-lg font-semibold"
            style={{ color: 'var(--td-text-color-primary)' }}
          >
            {APP_CONFIG.name}
          </span>
        </div>
      </div>

      {/* 新对话按钮 */}
      <div className="p-3 space-y-2">
        <Button 
          icon={<AddIcon />}
          onClick={onNewChat}
          block
          variant="outline"
        >
          新对话
        </Button>
        <Button 
          icon={<ShoppingBag size={16} />}
          onClick={onOpenProducts}
          block
          variant={isProductsPage ? 'outline' : 'text'}
          theme={isProductsPage ? 'primary' : 'default'}
        >
          美客多商品抓取
        </Button>
        <Button 
          icon={<ShoppingBag size={16} />}
          onClick={onOpenSourcing}
          block
          variant={isSourcingPage ? 'outline' : 'text'}
          theme={isSourcingPage ? 'primary' : 'default'}
        >
          货源与利润
        </Button>
        <Button 
          icon={<ShoppingBag size={16} />}
          onClick={onOpenCandidates}
          block
          variant={isCandidatesPage ? 'outline' : 'text'}
          theme={isCandidatesPage ? 'primary' : 'default'}
        >
          AI 选品
        </Button>
        <Button 
          icon={<ShoppingBag size={16} />}
          onClick={onOpenListing}
          block
          variant={isListingPage ? 'outline' : 'text'}
          theme={isListingPage ? 'primary' : 'default'}
        >
          合规上架
        </Button>
        <Button 
          icon={<ShoppingBag size={16} />}
          onClick={onOpenOrders}
          block
          variant={isOrdersPage ? 'outline' : 'text'}
          theme={isOrdersPage ? 'primary' : 'default'}
        >
          订单管理
        </Button>
        <Button
          icon={<InboxIcon size={16} />}
          onClick={onOpenMiaoshouBox}
          block
          variant={isMiaoshouBoxPage ? 'outline' : 'text'}
          theme={isMiaoshouBoxPage ? 'primary' : 'default'}
        >
          妙手采集箱
        </Button>
        <Button
          icon={<ToolsIcon size={16} />}
          onClick={onOpenConfig}
          block
          variant={isConfigPage ? 'outline' : 'text'}
          theme={isConfigPage ? 'primary' : 'default'}
        >
          配置中心
        </Button>
        <Button 
          icon={<Flame size={16} />}
          onClick={onOpenTrends}
          block
          variant={isTrendsPage ? 'outline' : 'text'}
          theme={isTrendsPage ? 'primary' : 'default'}
        >
          热搜词
        </Button>
        <Button 
          icon={<ShoppingBag size={16} />}
          onClick={onOpenProductAdmin}
          block
          variant={isProductAdminPage ? 'outline' : 'text'}
          theme={isProductAdminPage ? 'primary' : 'default'}
        >
          商品管理
        </Button>
      </div>

      {/* 会话列表 */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {sessions.map(session => {
          const sessionAgent = session.agentId ? getAgent(session.agentId) : getAgent('default');
          const AgentIcon = ICON_MAP[sessionAgent?.icon || 'Bot'] || Bot;
          return (
            <div 
              key={session.id}
              className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg cursor-pointer transition-colors duration-200 group"
              style={{
                backgroundColor: session.id === currentSessionId && !isSettingsPage
                  ? 'var(--td-brand-color-light)' 
                  : 'transparent',
                color: session.id === currentSessionId && !isSettingsPage
                  ? 'var(--td-brand-color)' 
                  : 'var(--td-text-color-secondary)'
              }}
              onClick={() => onSelectSession(session.id)}
              onMouseEnter={(e) => {
                if (session.id !== currentSessionId || isSettingsPage) {
                  e.currentTarget.style.backgroundColor = 'var(--td-bg-color-component-hover)';
                }
              }}
              onMouseLeave={(e) => {
                if (session.id !== currentSessionId || isSettingsPage) {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }
              }}
            >
              <div 
                className="flex-shrink-0 w-5 h-5 rounded flex items-center justify-center"
                style={{ backgroundColor: sessionAgent?.color || 'var(--td-brand-color)' }}
              >
                <AgentIcon size={12} color="white" />
              </div>
              <span className="flex-1 truncate text-sm">{session.title}</span>
              <Tooltip content="删除会话">
                <Button
                  className="opacity-0 group-hover:opacity-100 transition-opacity"
                  variant="text"
                  shape="circle"
                  size="medium"
                  icon={<DeleteIcon />}
                  onClick={(e) => {
                    e.stopPropagation();
                    confirmDialog({
                      header: '删除会话',
                      body: `确定删除会话「${session.title}」吗？该会话的聊天记录将被清除，且不可恢复。`,
                      confirmText: '删除',
                    }).then((confirmed) => {
                      if (confirmed) onDeleteSession(session.id);
                    });
                  }}
                />
              </Tooltip>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
