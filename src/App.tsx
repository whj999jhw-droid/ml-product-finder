import { useState, useEffect, useCallback } from 'react';
import { Routes, Route, useNavigate, useParams, useLocation } from 'react-router-dom';
import '@tdesign-react/chat/es/style/index.js';

import { useAgents } from './hooks/useAgents';
import { useTheme } from './hooks/useTheme';
import { useSessions } from './hooks/useSessions';
import { useModels } from './hooks/useModels';
import { useChat } from './hooks/useChat';
import { PermissionMode } from './types';

import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { SettingsPage } from './components/SettingsPage';
import { ChatPage } from './pages/ChatPage';
import { ProductFinderPage } from './pages/ProductFinderPage';
import { SourcingPage } from './pages/SourcingPage';
import { ListingPage } from './pages/ListingPage';
import { StoreManagementPage } from './pages/StoreManagementPage';
import { OrdersPage } from './pages/OrdersPage';
import { TrendsPage } from './pages/TrendsPage';
import { NotificationSettingsPage } from './pages/NotificationSettingsPage';
import { ProductManagerPage } from './pages/ProductManagerPage';
import { CandidatesPage } from './pages/CandidatesPage';

function App() {
  return (
    <Routes>
      <Route path="/" element={<AppContent />} />
      <Route path="/chat/:sessionId" element={<AppContent />} />
      <Route path="/settings" element={<AppContent />} />
      <Route path="/products" element={<AppContent />} />
      <Route path="/sourcing" element={<AppContent />} />
      <Route path="/listing" element={<AppContent />} />
      <Route path="/stores" element={<AppContent />} />
      <Route path="/orders" element={<AppContent />} />
      <Route path="/notifications" element={<AppContent />} />
      <Route path="/trends" element={<AppContent />} />
      <Route path="/product-admin" element={<AppContent />} />
      <Route path="/candidates" element={<AppContent />} />
    </Routes>
  );
}

function AppContent() {
  const navigate = useNavigate();
  const { sessionId: urlSessionId } = useParams<{ sessionId: string }>();
  const location = useLocation();
  const isSettingsPage = location.pathname === '/settings';
  const isProductsPage = location.pathname === '/products';
  const isSourcingPage = location.pathname === '/sourcing';
  const isListingPage = location.pathname === '/listing';
  const isStoresPage = location.pathname === '/stores';
  const isOrdersPage = location.pathname === '/orders';
  const isNotificationsPage = location.pathname === '/notifications';
  const isTrendsPage = location.pathname === '/trends';
  const isProductAdminPage = location.pathname === '/product-admin';
  const isCandidatesPage = location.pathname === '/candidates';

  // Hooks
  const { theme, toggleTheme } = useTheme();
  const { agents, addAgent, updateAgent, deleteAgent, getAgent } = useAgents();
  const { models, selectedModel, setSelectedModel, fetchModels } = useModels();
  const {
    sessions,
    setSessions,
    currentSessionId,
    setCurrentSessionId,
    currentSession,
    sessionModels,
    fetchSessions,
    deleteSession,
    updateSessionModel,
    addSession,
    updateSession,
    updateSessionMessages,
  } = useSessions();

  // 聊天 Hook
  const {
    isLoading,
    inputValue,
    setInputValue,
    permissionRequest,
    sendMessage,
    handleStop,
    handlePermissionAllow,
    handlePermissionDeny,
  } = useChat({
    currentSession,
    currentSessionId,
    selectedModel,
    getAgent,
    addSession,
    updateSession,
    updateSessionMessages,
    updateSessionModel,
    setCurrentSessionId,
    setSessions,
  });

  // 获取当前会话的 Agent
  const currentAgent = currentSession?.agentId ? getAgent(currentSession.agentId) : getAgent('default');

  // 从 URL 同步 sessionId
  useEffect(() => {
    if (urlSessionId && urlSessionId !== currentSessionId) {
      setCurrentSessionId(urlSessionId);
    } else if (!urlSessionId && !isSettingsPage && currentSessionId) {
      setCurrentSessionId(null);
    }
  }, [urlSessionId, isSettingsPage, currentSessionId, setCurrentSessionId]);

  // 当切换会话时，恢复该会话的模型选择
  useEffect(() => {
    if (currentSessionId && sessionModels[currentSessionId]) {
      setSelectedModel(sessionModels[currentSessionId]);
    } else if (currentSession) {
      setSelectedModel(currentSession.model);
    }
  }, [currentSessionId, sessionModels, currentSession, setSelectedModel]);

  // 初始加载会话列表
  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // 更新当前会话的模型
  const updateCurrentSessionModel = useCallback((modelId: string) => {
    setSelectedModel(modelId);
    if (currentSessionId) {
      updateSessionModel(currentSessionId, modelId);
    }
  }, [currentSessionId, updateSessionModel, setSelectedModel]);

  // 删除会话处理
  const handleDeleteSession = useCallback(async (sessionId: string) => {
    const navigateTo = await deleteSession(sessionId);
    if (navigateTo) {
      navigate(navigateTo);
    }
  }, [deleteSession, navigate]);

  // 侧边栏事件处理
  const handleNewChat = useCallback(() => {
    setCurrentSessionId(null);
    navigate('/');
  }, [navigate, setCurrentSessionId]);

  const handleSelectSession = useCallback((sessionId: string) => {
    setCurrentSessionId(sessionId);
    navigate(`/chat/${sessionId}`);
  }, [navigate, setCurrentSessionId]);

  const handleOpenSettings = useCallback(() => {
    navigate('/settings');
  }, [navigate]);

  const handleOpenProducts = useCallback(() => {
    navigate('/products');
  }, [navigate]);

  const handleOpenSourcing = useCallback(() => {
    navigate('/sourcing');
  }, [navigate]);

  const handleOpenListing = useCallback(() => {
    navigate('/listing');
  }, [navigate]);

  const handleOpenStores = useCallback(() => {
    navigate('/stores');
  }, [navigate]);

  const handleOpenOrders = useCallback(() => {
    navigate('/orders');
  }, [navigate]);

  const handleOpenNotifications = useCallback(() => {
    navigate('/notifications');
  }, [navigate]);

  const handleOpenTrends = useCallback(() => {
    navigate('/trends');
  }, [navigate]);

  const handleOpenProductAdmin = useCallback(() => {
    navigate('/product-admin');
  }, [navigate]);

  const handleOpenCandidates = useCallback(() => {
    navigate('/candidates');
  }, [navigate]);

  // 移动端检测：≤767px 视为手机，侧边栏切换为抽屉模式
  const [isMobile, setIsMobile] = useState<boolean>(
    typeof window !== 'undefined' &&
      window.matchMedia('(max-width: 767px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Sidebar 状态：桌面默认展开，移动端默认收起为抽屉
  const [sidebarOpen, setSidebarOpen] = useState(true);
  useEffect(() => {
    setSidebarOpen(!isMobile);
  }, [isMobile]);
  
  // 权限模式状态
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');

  return (
    <div 
      className="flex h-[100dvh] w-full overflow-hidden"
      style={{ backgroundColor: 'var(--td-bg-color-page)' }}
    >
      {/* 移动端抽屉遮罩 */}
      {isMobile && sidebarOpen && (
        <div
          className="fixed inset-0 z-30"
          style={{ backgroundColor: 'rgba(0,0,0,0.45)' }}
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* 侧边栏 */}
      <Sidebar
        isMobile={isMobile}
        sessions={sessions}
        currentSessionId={currentSessionId}
        isSettingsPage={isSettingsPage}
        isProductsPage={isProductsPage}
        isSourcingPage={isSourcingPage}
        isListingPage={isListingPage}
        isStoresPage={isStoresPage}
        isOrdersPage={isOrdersPage}
        isNotificationsPage={isNotificationsPage}
        isTrendsPage={isTrendsPage}
        isProductAdminPage={isProductAdminPage}
        isCandidatesPage={isCandidatesPage}
        sidebarOpen={sidebarOpen}
        agents={agents}
        getAgent={getAgent}
        onNewChat={handleNewChat}
        onSelectSession={handleSelectSession}
        onDeleteSession={handleDeleteSession}
        onOpenSettings={handleOpenSettings}
        onOpenProducts={handleOpenProducts}
        onOpenSourcing={handleOpenSourcing}
        onOpenListing={handleOpenListing}
        onOpenStores={handleOpenStores}
        onOpenOrders={handleOpenOrders}
        onOpenNotifications={handleOpenNotifications}
        onOpenTrends={handleOpenTrends}
        onOpenProductAdmin={handleOpenProductAdmin}
        onOpenCandidates={handleOpenCandidates}
      />

      {/* 主内容区 */}
      <main 
        className="flex-1 flex flex-col min-w-0 overflow-auto"
        style={{ backgroundColor: 'var(--td-bg-color-page)' }}
      >
        {/* 顶部栏 */}
        <Header
          isSettingsPage={isSettingsPage}
          isProductsPage={isProductsPage}
          isSourcingPage={isSourcingPage}
          isListingPage={isListingPage}
          isStoresPage={isStoresPage}
          isOrdersPage={isOrdersPage}
          isNotificationsPage={isNotificationsPage}
          isTrendsPage={isTrendsPage}
          isProductAdminPage={isProductAdminPage}
          isCandidatesPage={isCandidatesPage}
          sidebarOpen={sidebarOpen}
          theme={theme}
          currentSession={currentSession}
          currentAgent={currentAgent}
          models={models}
          onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
          onToggleTheme={toggleTheme}
          onRefreshModels={fetchModels}
        />

        {/* 设置页面或聊天页面或商品页面 */}
        {isSettingsPage ? (
          <SettingsPage
            agents={agents}
            onAdd={addAgent}
            onUpdate={updateAgent}
            onDelete={deleteAgent}
          />
        ) : isProductsPage ? (
          <ProductFinderPage />
        ) : isSourcingPage ? (
          <SourcingPage />
        ) : isListingPage ? (
          <ListingPage />
        ) : isStoresPage ? (
          <StoreManagementPage />
        ) : isOrdersPage ? (
          <OrdersPage />
        ) : isNotificationsPage ? (
          <NotificationSettingsPage />
        ) : isTrendsPage ? (
          <TrendsPage />
        ) : isProductAdminPage ? (
          <ProductManagerPage />
        ) : isCandidatesPage ? (
          <CandidatesPage />
        ) : (
          <ChatPage
            currentSession={currentSession}
            models={models}
            selectedModel={selectedModel}
            agents={agents}
            isLoading={isLoading}
            inputValue={inputValue}
            permissionRequest={permissionRequest}
            permissionMode={permissionMode}
            onSendMessage={sendMessage}
            onStop={handleStop}
            onInputChange={setInputValue}
            onModelChange={updateCurrentSessionModel}
            onPermissionAllow={handlePermissionAllow}
            onPermissionDeny={handlePermissionDeny}
            onPermissionModeChange={setPermissionMode}
          />
        )}
      </main>
    </div>
  );
}

export default App;
