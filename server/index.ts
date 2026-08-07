import express from "express";
import { query, unstable_v2_createSession, unstable_v2_authenticate, PermissionResult, CanUseTool } from "@tencent-ai/agent-sdk";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import https from "https";
import http from "http";
import * as db from "./db.js";
import session from 'express-session';
import authRouter, { requireAuth } from './auth.js';

const execAsync = promisify(exec);

// 待处理的权限请求
interface PendingPermission {
  resolve: (result: PermissionResult) => void;
  reject: (error: Error) => void;
  toolName: string;
  input: Record<string, unknown>;
  sessionId: string;
  timestamp: number;
}

const pendingPermissions = new Map<string, PendingPermission>();

// 权限请求超时时间（5分钟）
const PERMISSION_TIMEOUT = 5 * 60 * 1000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Session（多用户登录态）
app.use(session({
  name: 'mlf_session',
  secret: process.env.SESSION_SECRET || 'dev-insecure-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 天
  },
}));

// 缓存可用模型列表
let cachedModels: Array<{ modelId: string; name: string; description?: string }> = [];
const defaultModel = "claude-sonnet-4";

// 健康检查
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// 用户认证路由（注册/登录/登出/me）
app.use('/api/auth', authRouter);

// 登录方式类型
type LoginMethod = 'env' | 'cli' | 'none';

interface LoginStatusResponse {
  isLoggedIn: boolean;
  method?: LoginMethod;
  envConfigured?: boolean;
  cliConfigured?: boolean;
  error?: string;
  apiKey?: string; // 脱敏后的 API Key
  envVars?: {
    apiKey?: string;
    authToken?: string;
    internetEnv?: string;
    baseUrl?: string;
  };
}

// 检查 CodeBuddy CLI 登录状态
app.get("/api/check-login", async (req, res) => {
  const response: LoginStatusResponse = {
    isLoggedIn: false,
    envConfigured: false,
    cliConfigured: false,
    envVars: {},
  };
  
  // 1. 检查环境变量
  const apiKey = process.env.CODEBUDDY_API_KEY;
  const authToken = process.env.CODEBUDDY_AUTH_TOKEN;
  const internetEnv = process.env.CODEBUDDY_INTERNET_ENVIRONMENT;
  const baseUrl = process.env.CODEBUDDY_BASE_URL;
  
  if (apiKey || authToken) {
    response.envConfigured = true;
    // 脱敏显示
    if (apiKey) {
      response.envVars!.apiKey = apiKey.slice(0, 8) + '****' + apiKey.slice(-4);
      response.apiKey = response.envVars!.apiKey;
    }
    if (authToken) {
      response.envVars!.authToken = authToken.slice(0, 8) + '****' + authToken.slice(-4);
    }
    if (internetEnv) {
      response.envVars!.internetEnv = internetEnv;
    }
    if (baseUrl) {
      response.envVars!.baseUrl = baseUrl;
    }
  }
  
  // 2. 使用 unstable_v2_authenticate 检查登录状态（更可靠）
  try {
    let needsLogin = false;
    
    const result = await unstable_v2_authenticate({
      environment: 'external',
      onAuthUrl: async (authState) => {
        // 如果执行到这个回调，说明未登录
        needsLogin = true;
        console.log('[Check Login] 需要登录，认证 URL:', authState.authUrl);
        // 将认证 URL 返回给前端（如果需要）
        response.error = '未登录，请先登录 CodeBuddy CLI';
      }
    });
    
    // 如果没有触发 onAuthUrl 回调，说明已登录
    if (!needsLogin && result?.userinfo) {
      response.isLoggedIn = true;
      response.cliConfigured = true;
      
      // 判断登录方式
      if (response.envConfigured) {
        response.method = 'env';
      } else {
        response.method = 'cli';
      }
      
      console.log('[Check Login] 已登录用户:', result.userinfo.userName);
    } else if (!needsLogin) {
      // result 存在但没有 userinfo，仍然认为已登录
      response.isLoggedIn = true;
      response.cliConfigured = true;
      response.method = response.envConfigured ? 'env' : 'cli';
    }
  } catch (error: any) {
    console.error("[Check Login] SDK Error:", error);
    
    // 如果有环境变量配置，仍然认为是登录状态
    if (response.envConfigured) {
      response.isLoggedIn = true;
      response.method = 'env';
    } else {
      response.error = error?.message || String(error);
      response.method = 'none';
    }
  }
  
  res.json(response);
});

// 保存环境变量配置
app.post("/api/save-env-config", (req, res) => {
  const { apiKey, authToken, internetEnv, baseUrl } = req.body;
  
  if (!apiKey && !authToken) {
    return res.status(400).json({ error: '请至少配置 API Key 或 Auth Token' });
  }
  
  const configuredVars: string[] = [];
  
  // 设置环境变量（仅在当前进程有效）
  if (apiKey) {
    process.env.CODEBUDDY_API_KEY = apiKey;
    configuredVars.push('CODEBUDDY_API_KEY');
  }
  if (authToken) {
    process.env.CODEBUDDY_AUTH_TOKEN = authToken;
    configuredVars.push('CODEBUDDY_AUTH_TOKEN');
  }
  if (internetEnv) {
    process.env.CODEBUDDY_INTERNET_ENVIRONMENT = internetEnv;
    configuredVars.push('CODEBUDDY_INTERNET_ENVIRONMENT');
  }
  if (baseUrl) {
    process.env.CODEBUDDY_BASE_URL = baseUrl;
    configuredVars.push('CODEBUDDY_BASE_URL');
  }
  
  // 清除模型缓存，以便重新获取
  cachedModels = [];
  
  res.json({ 
    success: true, 
    message: `已设置: ${configuredVars.join(', ')}`,
    note: '环境变量仅在当前服务器进程有效，重启后需要重新设置'
  });
});

// 获取可用模型列表
app.get("/api/models", async (req, res) => {
  try {
    if (cachedModels.length === 0) {
      console.log("[Models] Creating session to fetch available models...");
      
      const session = await unstable_v2_createSession({ 
        cwd: process.cwd()
      });
      
      console.log("[Models] Session created, calling getAvailableModels()...");
      const models = await session.getAvailableModels();
      console.log("[Models] Got", models.length, "models");
      
      if (models && Array.isArray(models)) {
        cachedModels = models;
      }
    }
    
    res.json({ 
      models: cachedModels.length > 0 ? cachedModels : [
        { modelId: "claude-sonnet-4", name: "Claude Sonnet 4" }
      ],
      defaultModel 
    });
  } catch (error: any) {
    console.error("[Models] Error:", error);
    res.json({
      models: [
        { modelId: "claude-sonnet-4", name: "Claude Sonnet 4" },
        { modelId: "claude-opus-4", name: "Claude Opus 4" }
      ],
      defaultModel,
      error: error?.message || String(error)
    });
  }
});

// ============= 会话 API =============

// 获取所有会话（包含消息数量）
app.get("/api/sessions", (req, res) => {
  try {
    const sessions = db.getAllSessions();
    const sessionsWithMessages = sessions.map(session => {
      const messages = db.getMessagesBySession(session.id);
      return {
        ...session,
        messageCount: messages.length
      };
    });
    res.json({ sessions: sessionsWithMessages });
  } catch (error: any) {
    console.error("[Sessions] Error:", error);
    res.status(500).json({ error: error?.message || "获取会话失败" });
  }
});

// 获取单个会话及其消息
app.get("/api/sessions/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = db.getSession(sessionId);
    
    if (!session) {
      return res.status(404).json({ error: "会话不存在" });
    }
    
    const messages = db.getMessagesBySession(sessionId);
    
    // 解析 tool_calls JSON
    const parsedMessages = messages.map(msg => ({
      ...msg,
      tool_calls: msg.tool_calls ? JSON.parse(msg.tool_calls) : null
    }));
    
    res.json({ session, messages: parsedMessages });
  } catch (error: any) {
    console.error("[Session] Error:", error);
    res.status(500).json({ error: error?.message || "获取会话失败" });
  }
});

// 创建新会话
app.post("/api/sessions", (req, res) => {
  try {
    const { model = defaultModel, title = "新对话" } = req.body;
    const now = new Date().toISOString();
    
    const session = db.createSession({
      id: uuidv4(),
      title,
      model,
      created_at: now,
      updated_at: now
    });
    
    res.json({ session });
  } catch (error: any) {
    console.error("[Create Session] Error:", error);
    res.status(500).json({ error: error?.message || "创建会话失败" });
  }
});

// 更新会话
app.patch("/api/sessions/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const { title, model } = req.body;
    
    const success = db.updateSession(sessionId, { title, model });
    
    if (!success) {
      return res.status(404).json({ error: "会话不存在" });
    }
    
    res.json({ success: true });
  } catch (error: any) {
    console.error("[Update Session] Error:", error);
    res.status(500).json({ error: error?.message || "更新会话失败" });
  }
});

// 删除会话
app.delete("/api/sessions/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const success = db.deleteSession(sessionId);
    
    if (!success) {
      return res.status(404).json({ error: "会话不存在" });
    }
    
    res.json({ success: true });
  } catch (error: any) {
    console.error("[Delete Session] Error:", error);
    res.status(500).json({ error: error?.message || "删除会话失败" });
  }
});

// ============= 聊天 API =============

// 权限响应 API
app.post("/api/permission-response", (req, res) => {
  const { requestId, behavior, message } = req.body;
  
  console.log(`[Permission] Response received: requestId=${requestId}, behavior=${behavior}`);
  
  const pending = pendingPermissions.get(requestId);
  if (!pending) {
    console.log(`[Permission] Request not found: ${requestId}`);
    return res.status(404).json({ error: "权限请求不存在或已超时" });
  }
  
  // 清除请求
  pendingPermissions.delete(requestId);
  
  if (behavior === 'allow') {
    pending.resolve({
      behavior: 'allow',
      updatedInput: pending.input
    });
  } else {
    pending.resolve({
      behavior: 'deny',
      message: message || '用户拒绝了此操作'
    });
  }
  
  res.json({ success: true });
});

// 发送消息并获取流式响应
app.post("/api/chat", async (req, res) => {
  const { sessionId, message, model, systemPrompt, cwd, permissionMode } = req.body;
  
  // 请求日志
  console.log(`\n[Chat] ========== 新请求 ==========`);
  console.log(`[Chat] SessionId: ${sessionId}`);
  console.log(`[Chat] Model: ${model}`);
  console.log(`[Chat] Message: ${message?.slice(0, 100)}${message?.length > 100 ? '...' : ''}`);
  console.log(`[Chat] CWD: ${cwd || 'default'}`);

  if (!message) {
    console.log(`[Chat] 错误: 消息为空`);
    return res.status(400).json({ error: "消息不能为空" });
  }

  // 获取或创建会话
  let session = sessionId ? db.getSession(sessionId) : null;
  const now = new Date().toISOString();
  
  if (!session) {
    // 创建新会话
    console.log(`[Chat] 创建新会话`);
    session = db.createSession({
      id: sessionId || uuidv4(),
      title: message.slice(0, 30) + (message.length > 30 ? '...' : ''),
      model: model || defaultModel,
      sdk_session_id: null,  // 稍后从 SDK 获取
      created_at: now,
      updated_at: now
    });
  } else {
    console.log(`[Chat] 使用现有会话, SDK Session: ${session.sdk_session_id || 'none'}`);
  }

  const selectedModel = model || session.model;
  
  // 获取 SDK session ID（用于恢复对话）
  const sdkSessionId = session.sdk_session_id;

  // 创建用户消息 ID 和助手消息 ID
  const userMessageId = uuidv4();
  const assistantMessageId = uuidv4();

  // 保存用户消息到数据库
  try {
    db.createMessage({
      id: userMessageId,
      session_id: session.id,
      role: 'user',
      content: message,
      model: null,
      created_at: now,
      tool_calls: null
    });
    console.log(`[Chat] 用户消息已保存: ${userMessageId}`);
  } catch (dbError: any) {
    console.error(`[Chat] 保存用户消息失败:`, dbError);
    return res.status(500).json({ error: "保存消息失败", detail: dbError?.message });
  }

  // 设置 SSE 头
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // 默认系统提示词
  const defaultSystemPrompt = "你是一个专业的AI助手，善于帮助用户解决各种问题。请用简洁清晰的方式回答问题。";
  
  // 工作目录：优先使用请求中的 cwd，否则使用当前目录
  const workingDir = cwd || process.cwd();

  try {
    console.log(`[Chat] 调用 SDK query...`);
    console.log(`[Chat] - Model: ${selectedModel}`);
    console.log(`[Chat] - Resume: ${sdkSessionId || 'none'}`);
    console.log(`[Chat] - CWD: ${workingDir}`);
    console.log(`[Chat] - PermissionMode: ${permissionMode || 'default'}`);
    
    // 创建 canUseTool 回调
    const canUseTool: CanUseTool = async (toolName, input, options) => {
      console.log(`[Permission] Tool request: ${toolName}`);
      console.log(`[Permission] Input:`, JSON.stringify(input, null, 2));
      
      // bypassPermissions 模式直接放行
      if (permissionMode === 'bypassPermissions') {
        console.log(`[Permission] Bypassing permissions for ${toolName}`);
        return { behavior: 'allow', updatedInput: input };
      }
      
      // 创建权限请求
      const requestId = uuidv4();
      const permissionRequest = {
        requestId,
        toolUseId: options.toolUseID,
        toolName,
        input,
        sessionId: session.id,
        timestamp: Date.now()
      };
      
      // 发送权限请求到前端
      res.write(`data: ${JSON.stringify({ 
        type: "permission_request", 
        ...permissionRequest
      })}\n\n`);
      
      // 创建 Promise 等待用户响应
      return new Promise<PermissionResult>((resolve, reject) => {
        const pending: PendingPermission = {
          resolve,
          reject,
          toolName,
          input,
          sessionId: session.id,
          timestamp: Date.now()
        };
        
        pendingPermissions.set(requestId, pending);
        
        // 设置超时
        setTimeout(() => {
          if (pendingPermissions.has(requestId)) {
            pendingPermissions.delete(requestId);
            console.log(`[Permission] Request timeout: ${requestId}`);
            resolve({
              behavior: 'deny',
              message: '权限请求超时'
            });
          }
        }, PERMISSION_TIMEOUT);
      });
    };
    
    // 使用 Query API 发送消息
    // 如果有 sdk_session_id，使用 resume 恢复对话上下文
    const stream = query({
      prompt: message,
      options: {
        cwd: workingDir,
        model: selectedModel,
        maxTurns: 10,
        systemPrompt: systemPrompt || defaultSystemPrompt,
        permissionMode: permissionMode || 'default',
        canUseTool,
        ...(sdkSessionId ? { resume: sdkSessionId } : {})  // 使用 resume 恢复对话
      }
    });

    let fullResponse = "";
    let toolCalls: Array<{ 
      id: string; 
      name: string; 
      input?: Record<string, unknown>;
      status: string; 
      result?: string;
      isError?: boolean;
    }> = [];
    let newSdkSessionId: string | null = null;  // 用于存储 SDK 返回的 session_id

    // 发送会话ID和消息ID
    res.write(`data: ${JSON.stringify({ 
      type: "init", 
      sessionId: session.id, 
      userMessageId, 
      assistantMessageId,
      model: selectedModel 
    })}\n\n`);

    // 当前正在执行的工具 ID（用于匹配 tool_result）
    let currentToolId: string | null = null;

    // 处理流式响应
    for await (const msg of stream) {
      console.log("[Stream] Message type:", msg.type, msg);
      
      // 处理 system 消息，获取 SDK 的 session_id
      if (msg.type === "system" && (msg as any).subtype === "init") {
        newSdkSessionId = (msg as any).session_id;
        console.log(`[Stream] Got SDK session_id: ${newSdkSessionId}`);
        
        // 保存 SDK session_id 到数据库（如果是新的）
        if (newSdkSessionId && newSdkSessionId !== sdkSessionId) {
          db.updateSession(session.id, { sdk_session_id: newSdkSessionId });
          console.log(`[Stream] Saved SDK session_id to database`);
        }
      } else if (msg.type === "assistant") {
        const content = msg.message.content;

        if (typeof content === "string") {
          fullResponse += content;
          res.write(`data: ${JSON.stringify({ type: "text", content })}\n\n`);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text") {
              fullResponse += block.text;
              res.write(`data: ${JSON.stringify({ type: "text", content: block.text })}\n\n`);
            } else if (block.type === "tool_use") {
              currentToolId = block.id || uuidv4();
              const toolInput = (block as any).input || {};
              console.log(`[Stream] Tool use: id=${currentToolId}, name=${block.name}`);
              console.log(`[Stream] Tool input:`, JSON.stringify(toolInput, null, 2));
              
              const toolCall = { 
                id: currentToolId, 
                name: block.name, 
                input: toolInput,
                status: "running" 
              };
              toolCalls.push(toolCall);
              res.write(`data: ${JSON.stringify({ 
                type: "tool", 
                id: toolCall.id,
                name: toolCall.name,
                input: toolCall.input,
                status: toolCall.status
              })}\n\n`);
            }
          }
        }
      } else if (msg.type === "tool_result") {
        // 处理工具结果（独立的消息类型）
        const msgAny = msg as any;
        const toolId = msgAny.tool_use_id || currentToolId;
        const isError = msgAny.is_error || false;
        const content = msgAny.content;
        
        console.log(`[Stream] Tool result: tool_use_id=${toolId}, is_error=${isError}`);
        console.log(`[Stream] Tool result content type:`, typeof content);
        console.log(`[Stream] Tool result content:`, typeof content === 'string' ? content.slice(0, 500) : JSON.stringify(content, null, 2)?.slice(0, 500));
        
        const tool = toolCalls.find(t => t.id === toolId) || toolCalls[toolCalls.length - 1];
        if (tool) {
          tool.status = isError ? "error" : "completed";
          tool.isError = isError;
          tool.result = typeof content === 'string' 
            ? content 
            : JSON.stringify(content);
          res.write(`data: ${JSON.stringify({ 
            type: "tool_result", 
            toolId: tool.id, 
            content: tool.result,
            isError: isError
          })}\n\n`);
        }
        currentToolId = null;
      } else if (msg.type === "result") {
        // 完成时确保所有工具都标记为完成
        toolCalls.forEach(tool => {
          if (tool.status === "running") {
            tool.status = "completed";
            res.write(`data: ${JSON.stringify({ type: "tool_result", toolId: tool.id, content: tool.result || "已完成" })}\n\n`);
          }
        });
        res.write(`data: ${JSON.stringify({ type: "done", duration: msg.duration, cost: msg.cost })}\n\n`);
      }
    }

    // 保存助手消息到数据库
    db.createMessage({
      id: assistantMessageId,
      session_id: session.id,
      role: 'assistant',
      content: fullResponse,
      model: selectedModel,
      created_at: new Date().toISOString(),
      tool_calls: toolCalls.length > 0 ? JSON.stringify(toolCalls) : null
    });

    // 更新会话标题（如果是第一条消息）
    const messages = db.getMessagesBySession(session.id);
    if (messages.length <= 2) {
      db.updateSession(session.id, { 
        title: message.slice(0, 30) + (message.length > 30 ? '...' : ''),
        model: selectedModel
      });
    }

    console.log(`[Chat] 请求完成 ✓`);
    res.end();
  } catch (error: any) {
    console.error(`\n[Chat] ========== 错误 ==========`);
    console.error(`[Chat] Error Name:`, error?.name);
    console.error(`[Chat] Error Message:`, error?.message);
    console.error(`[Chat] Error Code:`, error?.code);
    console.error(`[Chat] Error Stack:`, error?.stack);
    console.error(`[Chat] Full Error:`, JSON.stringify(error, null, 2));
    
    const errorMessage = error?.message || "处理请求时发生错误";
    res.write(`data: ${JSON.stringify({ type: "error", message: errorMessage })}\n\n`);
    res.end();
  }
});

// ============= Mercado Libre API =============

import {
  ML_SITES,
  MLSiteCode,
  FetchOptions,
  fetchAllProductsAndExport,
  getCategories,
  getExportedFiles,
  setAccessToken,
  getAccessToken,
  getFullAccessToken,
  hasAccessToken,
  validateAccessToken,
  setOAuthConfig,
  getOAuthConfig,
  hasOAuthConfig,
  generateAuthUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  getClientCredentialsToken,
  ensureValidToken,
  initAutoRenew,
  getTokenExpiry,
  getRefreshToken,
  getEffectiveRedirectUri,
  setTunnelCallbackUrl,
  getTunnelCallbackUrl,
  ensureOAuthRedirectResolved,
  reresolveOAuthRedirect,
  overrideResolvedRedirect,
  DEFAULT_FIXED_REDIRECT_URI,
  exportProductsToXlsx,
  getFallbackCategories,
  setProxyConfig,
  getProxyConfig,
  setApiProxyUrl,
  getApiProxyConfig,
  loadCheckpoint,
  saveCheckpoint,
  deleteCheckpoint,
  type FetchCheckpoint,
} from './mercadolibre.js';
import { sendXlsxResult, sendTestEmail, getEmailConfig, saveEmailConfig, loadEmailConfig } from './email.js';
import * as storeAuth from './storeAuth.js';
import * as stores from './stores.js';
import * as notify from './notify.js';
import * as orders from './orders.js';
import { getSchedule, saveSchedule, startScheduler } from './scheduler.js';
import { startTunnel, stopTunnel, getTunnelInfo, isTunnelRunning } from './tunnel.js';
import * as sourcing from './sourcing.js';
import * as listing from './listing.js';
import * as profit from './profit.js';
import { runFilterPipeline, defaultFilterConfig } from './filterPipeline.js';
import { writeErpExport } from './erpExport.js';
import * as titleGen from './titleGenerator.js';
import {
  aiGenerateTitles,
  aiGenerateDescription,
  aiGenerateTitlesBatch,
  aiGenerateDescriptionsBatch,
  getLlmConfig,
  saveLlmConfig,
  translateTrendsKeywords,
  testLlmTranslation,
  probeLlmReachability,
  translateOrderTexts,
} from './aiService.js';
import * as imagePipeline from './imagePipeline.js';
import { getTrendsKeywords, getTrends } from './trends.js';

// 获取可用站点列表
app.get('/api/ml/sites', (req, res) => {
  const sites = Object.entries(ML_SITES).map(([code, info]) => ({
    code,
    name: info.name,
    currency: info.currency,
  }));
  res.json({ sites, hasToken: hasAccessToken() });
});

// ============= ML Token 管理 =============

// 检查 token 状态
app.get('/api/ml/token', async (req, res) => {
  await ensureValidToken();
  const token = getAccessToken();
  res.json({
    hasToken: token.length > 0,
    tokenPreview: token ? token.slice(0, 12) + '****' + token.slice(-4) : '',
  });
});

// 设置 token
app.post('/api/ml/token', (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: '请提供 access token' });
  }
  setAccessToken(token.trim());
  console.log('[ML Token] Access token 已设置');
  res.json({ success: true, message: 'Token 已保存' });
});

// 验证 token
app.post('/api/ml/token/validate', async (req, res) => {
  try {
    const result = await validateAccessToken();
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ valid: false, message: error?.message || '验证失败' });
  }
});

// ============= ML OAuth2 管理 =============

// 获取 OAuth2 配置状态
app.get('/api/ml/oauth/config', (req, res) => {
  const config = getOAuthConfig();
  const expiry = getTokenExpiry();
  const tunnel = getTunnelInfo();
  res.json({
    hasConfig: hasOAuthConfig(),
    appId: config.appId,
    secretKeyPreview: config.secretKey,
    redirectUri: config.redirectUri,
    effectiveRedirectUri: getEffectiveRedirectUri(),
    tunnelRunning: isTunnelRunning(),
    tunnelUrl: tunnel?.url || '',
    tunnelCallbackUrl: tunnel?.callbackUrl || '',
    hasRefreshToken: getRefreshToken().length > 0,
    tokenExpiry: expiry ? expiry.toISOString() : null,
    tokenExpired: expiry ? expiry < new Date() : true,
  });
});

// 保存 OAuth2 配置（App ID + Secret Key）
app.post('/api/ml/oauth/config', (req, res) => {
  const { appId, secretKey, redirectUri } = req.body;
  if (!appId || !secretKey) {
    return res.status(400).json({ error: '请提供 App ID 和 Secret Key' });
  }
  setOAuthConfig({
    appId: appId.trim(),
    secretKey: secretKey.trim(),
    ...(redirectUri ? { redirectUri: redirectUri.trim() } : {}),
  });
  console.log('[ML OAuth] 配置已保存, App ID:', appId.trim().slice(0, 8) + '****');
  res.json({ success: true, message: 'OAuth 配置已保存' });
});

// 生成授权 URL（默认启用 PKCE，可用 ?pkce=false 关闭）
app.get('/api/ml/oauth/auth-url', (req, res) => {
  try {
    const usePkce = req.query.pkce !== 'false';
    const site = typeof req.query.site === 'string' ? req.query.site : undefined;
    const url = generateAuthUrl(usePkce, site);
    res.json({ url, pkce: usePkce, site: site || 'local' });
  } catch (error: any) {
    res.status(400).json({ error: error?.message || '生成授权 URL 失败' });
  }
});

// OAuth2 回调端点 — ML 授权后会重定向到这里
app.get('/api/ml/oauth/callback', async (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    console.error('[ML OAuth] 授权失败:', error, error_description);
    const errHtml = `<html><body style="font-family:sans-serif;text-align:center;padding:40px;">
      <h2 style="color:#f56c6c;">授权失败</h2>
      <p>${error}</p>
      ${error_description ? `<p style="color:#999;">${error_description}</p>` : ''}
      <p><a href="http://localhost:5173/products">返回应用</a></p>
    </body></html>`;
    return res.send(errHtml);
  }

  if (!code || typeof code !== 'string') {
    return res.status(400).send('Missing authorization code');
  }

  // 从请求中重建 redirect_uri（ML 实际重定向到的地址）
  const protocol = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const reconstructedRedirectUri = `${protocol}://${host}/api/ml/oauth/callback`;
  console.log('[ML OAuth] 回调请求 Host:', host);
  console.log('[ML OAuth] 重建的 redirect_uri:', reconstructedRedirectUri);

  console.log('[ML OAuth] 收到授权码，正在交换 token...');
  const result = await exchangeCodeForToken(code, reconstructedRedirectUri);

  if (result.success) {
    const successHtml = `<html><body style="font-family:sans-serif;text-align:center;padding:40px;">
      <h2 style="color:#67c23a;">授权成功！</h2>
      <p>${result.message}</p>
      <p>正在返回应用...</p>
      <script>setTimeout(() => { window.location.href = 'http://localhost:5173/products'; }, 2000);</script>
    </body></html>`;
    res.send(successHtml);
  } else {
    const failHtml = `<html><body style="font-family:sans-serif;text-align:center;padding:40px;">
      <h2 style="color:#f56c6c;">Token 获取失败</h2>
      <p>${result.message}</p>
      <p style="margin-top:20px;color:#999;">如果隧道地址已变化，请返回应用重新启动隧道并重新授权。</p>
      <p><a href="http://localhost:5173/products">返回应用</a></p>
    </body></html>`;
    res.send(failHtml);
  }
});

// 手动交换授权码（备用方式：用户手动粘贴 code）
app.post('/api/ml/oauth/exchange', async (req, res) => {
  const { code, callbackUrl } = req.body;

  // 如果用户粘贴了完整回调 URL，从中提取 code 和 redirect_uri
  if (callbackUrl && typeof callbackUrl === 'string') {
    try {
      const parsed = new URL(callbackUrl);
      const extractedCode = parsed.searchParams.get('code');
      if (!extractedCode) {
        return res.status(400).json({ error: 'URL 中未找到 code 参数' });
      }
      // 从回调 URL 提取 redirect_uri（去掉 query 参数）
      const redirectUri = `${parsed.protocol}//${parsed.host}/api/ml/oauth/callback`;
      console.log('[ML OAuth] 手动交换 - 从 URL 提取:');
      console.log('  code:', extractedCode.slice(0, 10) + '...');
      console.log('  redirect_uri:', redirectUri);
      const result = await exchangeCodeForToken(extractedCode.trim(), redirectUri);
      return res.json(result);
    } catch (e: any) {
      return res.status(400).json({ error: 'URL 格式无效: ' + e.message });
    }
  }

  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: '请提供授权码或完整回调 URL' });
  }
  const result = await exchangeCodeForToken(code.trim());
  res.json(result);
});

// 刷新 access token
app.post('/api/ml/oauth/refresh', async (req, res) => {
  const result = await refreshAccessToken();
  res.json(result);
});

// ===================== 多店铺管理 =====================

// 生成「添加店铺」授权 URL（PKCE，按昵称/站点绑定 state）
app.get('/api/ml/oauth/store-auth-url', (req, res) => {
  try {
    const nickname = (req.query.nickname as string) || '';
    const site = (req.query.site as string) || 'MLM';
    const { url, state } = storeAuth.buildStoreAuthUrl({ nickname, site });
    res.json({ url, state });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || '生成授权链接失败' });
  }
});

// 一键「添加店铺」：自动确保公网隧道已启动 → 生成店铺授权 URL
// 这样前端点一次就能打开美客多授权页，无需手动起隧道（ML 不接受 localhost 回调）
app.post('/api/ml/oauth/store-begin', async (req, res) => {
  try {
    const { nickname, site: reqSite } = req.body || {};
    const site = ['MLM', 'MLB', 'MLC', 'MCO', 'CBT'].includes(reqSite) ? reqSite : 'MLM';
    // 1) 解析并探测当前生效的回调地址：固定域名可达直接用，不可达自动回退隧道
    const resolved = await ensureOAuthRedirectResolved();
    // 2) 生成店铺授权 URL（内部使用 getEffectiveRedirectUri() = resolved.uri）
    const { url, state } = storeAuth.buildStoreAuthUrl({
      nickname: (nickname || '').toString(),
      site: (site || 'MLM').toString(),
    });
    res.json({
      success: true,
      url,
      state,
      callbackUrl: resolved.uri,
      tunnelUrl: resolved.tunnelUrl || '',
      mode: resolved.mode,
      fixedRedirect: resolved.mode === 'fixed' || resolved.mode === 'env',
      reachable: resolved.reachable,
      notice: resolved.notice || '',
    });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || '生成授权链接失败' });
  }
});

// 店铺授权回调：ML 授权后跳转此处，用 code+state 换该店铺 token 并入库
app.get('/api/ml/oauth/store-callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  // 每次被访问都打日志，便于排查「回跳没到达后端 / 换 token 报错」
  console.log('[store-callback] 收到回调', {
    hasCode: !!code,
    hasState: !!state,
    error: error || null,
    error_description: error_description || null,
    url: req.originalUrl,
  });
  const effectiveCb = getEffectiveRedirectUri();
  const okHtml = (msg: string, warning?: string) =>
    `<html><body style="font-family:sans-serif;text-align:center;padding:40px;">
      <h2 style="color:#67c23a;">${msg}</h2>
      ${warning ? `<div style="max-width:560px;margin:16px auto;background:#fff7e6;border:1px solid #ffd591;padding:14px;border-radius:6px;color:#614700;font-size:14px;line-height:1.6;text-align:left;">${warning}</div>` : ''}
      <p>正在返回店铺管理...</p>
      <script>setTimeout(() => { window.location.href = '/stores'; }, 1500);</script>
    </body></html>`;
  const failHtml = (msg: string, detail?: string) =>
    `<html><body style="font-family:sans-serif;max-width:640px;margin:0 auto;padding:40px;line-height:1.6;">
      <h2 style="color:#f56c6c;">授权未成功</h2>
      <p style="color:#333;">${msg}</p>
      ${detail ? `<pre style="background:#f5f5f5;padding:12px;border-radius:6px;white-space:pre-wrap;word-break:break-all;font-size:13px;color:#c0392b;">${detail}</pre>` : ''}
      <div style="background:#fff7e6;border:1px solid #ffd591;padding:12px;border-radius:6px;margin:16px 0;font-size:13px;color:#614700;">
        <b>排查清单：</b><br/>
        1. 美客多开发者后台 → 你的应用 → <b>重定向 URI</b> 必须是完整地址：<br/>
        &nbsp;&nbsp;<code>${effectiveCb}</code>（含 <code>/api/ml/oauth/store-callback</code> 后缀，不能只填域名）<br/>
        2. 该地址的<b>公网隧道必须正在运行</b>（或已配置固定回调域名），店铺管理页「授权回调设置」可查看当前生效地址。<br/>
        3. 应用状态必须是 <b>Published</b>（Draft 仅应用所有者可授权）。<br/>
        4. 使用的 <b>ML_APP_ID / ML_SECRET_KEY</b> 必须和生成授权链接的是同一个应用。
      </div>
      <p><a href="/stores" style="color:#1677ff;">← 返回店铺管理</a></p>
    </body></html>`;

  if (error) {
    console.error('[store-callback] ML 返回错误:', error, error_description);
    return res.send(failHtml(`美客多拒绝授权：${error}`, error_description ? String(error_description) : undefined));
  }
  if (!code || typeof code !== 'string') {
    return res.status(400).send(failHtml('缺少授权码（可能是直接打开了回调地址，或 ML 未正确回跳）'));
  }
  // 旧版「全局账号授权」（货源与利润页「授权」按钮走这里）：无 state，换取并保存全局 token 供上架使用
  if (!state || typeof state !== 'string') {
    try {
      const cbProto = (req.headers['x-forwarded-proto'] as string) || (req.secure ? 'https' : 'http');
      const cbHost = (req.headers['x-forwarded-host'] as string) || (req.headers.host as string) || '';
      const cbOrigin = `${cbProto}://${cbHost}`;
      const result = await exchangeCodeForToken(code);
      if (result.success) {
        return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;">
          <h2 style="color:#67c23a;">✅ 全局账号授权成功！</h2>
          <p>${result.message}</p>
          <p>正在返回「货源与利润」页面...</p>
          <script>setTimeout(() => { window.location.href = '${cbOrigin}/sourcing'; }, 1500);</script>
        </body></html>`);
      }
      return res.send(failHtml('换取全局 token 失败', result.message));
    } catch (err: any) {
      console.error('[store-callback] 旧版全局授权换 token 失败:', err);
      return res.send(failHtml('换取全局 token 失败', err?.message || String(err)));
    }
  }
  try {
    const tok = await storeAuth.exchangeStoreCode(code, state);
    let mlUserNick = '';
    let mlUserId = '';
    let mlUserEmail = '';
    let mlSeller = false;
    let sellerLevel: string | null = null;
    try {
      const sellerInfo = await stores.getStoreSellerInfo({
        id: '', nickname: tok.nickname, site: tok.site, accessToken: tok.accessToken,
        refreshToken: tok.refreshToken, expiresAt: Date.now() + tok.expiresIn * 1000,
        enabled: true, createdAt: '',
      } as any);
      mlUserNick = sellerInfo.nickname || '';
      mlUserId = String(sellerInfo.id || '');
      mlUserEmail = sellerInfo.email || '';
      mlSeller = sellerInfo.isSeller || false;
      sellerLevel = sellerInfo.sellerLevel || null;
    } catch { /* ignore */ }

    const saved = stores.addStore({
      nickname: tok.nickname || mlUserNick || `${tok.site}店铺`,
      site: tok.site,
      accessToken: tok.accessToken,
      refreshToken: tok.refreshToken,
      expiresAt: Date.now() + tok.expiresIn * 1000,
      mlUserId,
      mlUserNick,
      mlUserEmail,
      mlSeller,
      enabled: true,
    });
    console.log('[store-callback] 店铺已添加:', saved.id, saved.mlUserNick || saved.nickname, 'isSeller=', mlSeller);
    const warning = mlSeller
      ? undefined
      : `<b>⚠️ 未检测到卖家资质</b><br/>授权账号 <code>${mlUserEmail || mlUserNick || '未知'}</code> 看起来不是卖家账号（无卖家声誉/销售权限）。请在浏览器中<b>退出该账号或切换到卖家账号</b>，然后回到店铺管理页删除本店铺并重新点击「添加店铺」授权。如果继续授权错误账号，订单将拉取为空。`;
    res.send(okHtml('店铺授权成功，已添加到多店铺列表！', warning));
  } catch (err: any) {
    console.error('[store-callback] 换 token / 入库失败:', err);
    res.send(failHtml('换取店铺 token 失败', err?.message || String(err)));
  }
});

// 店铺列表（token 已掩码）
app.get('/api/ml/stores', (req, res) => {
  res.json({ success: true, stores: stores.listStores() });
});

// 更新店铺（备注简称 / 启用开关 / 站点）
app.put('/api/ml/stores/:id', (req, res) => {
  const patch = req.body || {};
  const updated = stores.updateStore(req.params.id, patch);
  if (!updated) return res.status(404).json({ success: false, message: '店铺不存在' });
  res.json({ success: true, store: { ...updated, accessToken: '', refreshToken: '' } });
});

// 删除店铺
app.delete('/api/ml/stores/:id', (req, res) => {
  const ok = stores.deleteStore(req.params.id);
  res.json({ success: ok });
});

// 店铺最近订单（用于页面展示，拉前几笔已付款订单）—— CBT 兼容
app.get('/api/ml/stores/:id/orders', async (req, res) => {
  try {
    const store = stores.getStoreRaw(req.params.id);
    if (!store) return res.status(404).json({ success: false, message: '店铺不存在' });
    const recent = await orders.fetchRecentOrdersForStore(store, 10);
    res.json({ success: true, orders: recent });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || String(err) });
  }
});

// 店铺全部订单（分页拉取各状态，分类为 未发货/已发货/已取消），供订单管理页使用
app.get('/api/ml/stores/:id/all-orders', async (req, res) => {
  try {
    const store = stores.getStoreRaw(req.params.id);
    if (!store) return res.status(404).json({ success: false, message: '店铺不存在' });
    // 注意：不要解构出 orders，否则会与 import * as orders 模块同名造成「暂时性死区」
    const list = await orders.fetchAllOrdersForStore(store);
    res.json({ success: true, orders: list.orders, counts: list.counts });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || String(err) });
  }
});

// 单个订单完整详情（含物流、商品图片），供弹窗展示
app.get('/api/ml/orders/:id/detail', async (req, res) => {
  try {
    const storeId = (req.query.storeId as string) || '';
    const store = stores.getStoreRaw(storeId);
    if (!store) return res.status(404).json({ success: false, message: '店铺不存在或缺失 storeId' });
    const detail = await orders.fetchOrderDetail(store, req.params.id);
    res.json({ success: true, ...detail });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || String(err) });
  }
});

// 翻译订单中的西/葡语文本（商品标题、买家留言、地址备注等）为中文
app.post('/api/ml/translate-order', async (req, res) => {
  try {
    const { texts, site } = req.body || {};
    if (!Array.isArray(texts) || !texts.length) {
      return res.status(400).json({ success: false, message: 'texts 必须是且不能为空数组' });
    }
    const map = await translateOrderTexts(texts, site || 'MLM');
    res.json({ success: true, translations: map });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || String(err) });
  }
});

// ===================== 通知配置 =====================

// 短信配置（Twilio / Webhook）
app.get('/api/ml/sms-config', (req, res) => {
  res.json({ success: true, config: notify.getSmsConfig() });
});
app.post('/api/ml/sms-config', (req, res) => {
  const cfg = notify.saveSmsConfig(req.body || {});
  res.json({ success: true, config: cfg });
});

// 订单提醒总开关（含轮询间隔）
app.get('/api/ml/notify-config', (req, res) => {
  res.json({ success: true, config: notify.getNotifyConfig() });
});
app.post('/api/ml/notify-config', (req, res) => {
  const prevInterval = notify.getPollIntervalMs();
  const cfg = notify.saveNotifyConfig(req.body || {});
  // 如果轮询间隔发生变化，重启定时器
  if (notify.getPollIntervalMs() !== prevInterval) {
    restartOrderPolling();
  }
  res.json({ success: true, config: cfg });
});

// 短信测试（支持前端传入临时配置，未保存也能测；useLastOrder 用真实最近订单为例）
app.post('/api/ml/sms/test', async (req, res) => {
  const { text, config, useLastOrder } = req.body || {};
  try {
    if (useLastOrder) {
      const last = await orders.getLastRealOrderForTest();
      if (!last) return res.json({ success: false, message: '未找到任何已付款订单用于测试，请先确保店铺有订单' });
      const notifyResult = await notify.notifyNewOrder(last.store, last.order);
      const cfg = config && typeof config === 'object' ? config : undefined;
      const r = await notify.sendTestSmsWithConfig(notifyResult.smsText, cfg);
      return res.json({ ...r, preview: { smsText: notifyResult.smsText, html: notifyResult.html, text: notifyResult.text } });
    }
    const r = await notify.sendTestSmsWithConfig(
      typeof text === 'string' ? text : 'ML Product Finder 短信测试',
      config && typeof config === 'object' ? config : undefined,
    );
    res.json(r);
  } catch (e: any) {
    res.json({ success: false, message: e?.message || String(e) });
  }
});

// ===================== 订单轮询 =====================

// 手动触发一次全店订单轮询
app.post('/api/ml/orders/poll', async (req, res) => {
  try {
    const report = await orders.pollAllStores();
    res.json({ success: true, report });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || String(err) });
  }
});

// 订单提醒日志
app.get('/api/ml/orders/alerts', (req, res) => {
  res.json({ success: true, alerts: orders.getAlertLog() });
});

// 手动追加一条提醒记录（把「测试发送」结果也写入发送记录列表，带详情/删除）
app.post('/api/ml/orders/alerts', (req, res) => {
  try {
    const alert = req.body?.alert;
    if (!alert || typeof alert !== 'object' || !alert.orderId) {
      return res.status(400).json({ success: false, message: 'alert 对象缺少 orderId' });
    }
    orders.addAlert(alert);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || '写入提醒记录失败' });
  }
});

// 删除一条提醒记录（按 orderId）
app.delete('/api/ml/orders/alerts/:orderId', (req, res) => {
  try {
    const ok = orders.deleteAlert(req.params.orderId);
    res.json({ success: ok });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || '删除失败' });
  }
});

// 使用 client_credentials 获取应用级 token（无需用户授权）
app.post('/api/ml/oauth/client-credentials', async (req, res) => {
  const result = await getClientCredentialsToken();
  res.json(result);
});

// ============= 公网隧道（OAuth2 回调用） =============

// 自检路径：供后端探测固定回调域名是否真的可达（cloudflared 把流量转回本机后端时返回 {ok:true}）
app.get('/api/ml/oauth/ping', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// 获取隧道状态
app.get('/api/ml/oauth/tunnel', (req, res) => {
  const tunnel = getTunnelInfo();
  res.json({
    running: isTunnelRunning(),
    url: tunnel?.url || '',
    callbackUrl: tunnel?.callbackUrl || '',
    fixedRedirect: !!process.env.ML_REDIRECT_URI,
    redirectUri: getEffectiveRedirectUri(),
  });
});

// 启动公网隧道（手动覆盖：将当前生效回调切到临时隧道地址）
app.post('/api/ml/oauth/tunnel', async (req, res) => {
  try {
    const tunnel = await startTunnel();
    setTunnelCallbackUrl(tunnel.callbackUrl);
    overrideResolvedRedirect({
      uri: tunnel.callbackUrl,
      mode: 'tunnel',
      reachable: true,
      fixedDomain: DEFAULT_FIXED_REDIRECT_URI,
      tunnelUrl: tunnel.url,
      notice: `当前为临时 localtunnel 地址，每次启动可能变化。请在美客多开发者后台 → 你的应用 → 重定向 URI 改为：${tunnel.callbackUrl}。如需固定，请启动 cloudflared 后点「重新测试回调地址」。`,
    });
    res.json({ success: true, ...tunnel });
  } catch (error: any) {
    console.error('[Tunnel] 启动失败:', error);
    res.status(500).json({ success: false, message: error?.message || '启动隧道失败' });
  }
});

// 查询当前 OAuth 回调地址解析状态（fixed / tunnel / env + 可达性 + 提示）
app.get('/api/ml/oauth/callback-status', async (req, res) => {
  const r = await ensureOAuthRedirectResolved();
  const tunnel = getTunnelInfo();
  res.json({
    mode: r.mode,
    uri: r.uri,
    reachable: r.reachable,
    fixedDomain: r.fixedDomain,
    notice: r.notice || '',
    tunnelRunning: isTunnelRunning(),
    tunnelUrl: tunnel?.url || '',
  });
});

// 强制重新探测固定域名（用户启动 cloudflared 后点「重新测试」恢复固定域名用）
app.post('/api/ml/oauth/callback-test', async (req, res) => {
  try {
    const r = await reresolveOAuthRedirect();
    res.json({
      success: true,
      mode: r.mode,
      uri: r.uri,
      reachable: r.reachable,
      fixedDomain: r.fixedDomain,
      notice: r.notice || '',
      tunnelRunning: isTunnelRunning(),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || '重新测试失败' });
  }
});

// 关闭公网隧道
app.delete('/api/ml/oauth/tunnel', (req, res) => {
  stopTunnel();
  setTunnelCallbackUrl('');
  // 隧道关闭后：把当前生效回调切回固定域名（标记不可达，提示去启动 cloudflared / 重新测试）
  overrideResolvedRedirect({
    uri: DEFAULT_FIXED_REDIRECT_URI,
    mode: 'fixed',
    reachable: false,
    fixedDomain: DEFAULT_FIXED_REDIRECT_URI,
    notice: `临时隧道已手动停止。固定域名 ${DEFAULT_FIXED_REDIRECT_URI} 当前不可达，请启动 cloudflared 后点「重新测试回调地址」，或重新生成授权链接（会自动回退隧道）。`,
  });
  res.json({ success: true, message: '隧道已关闭' });
});

// 获取站点分类列表
app.get('/api/ml/categories/:siteId', async (req, res) => {
  try {
    const { siteId } = req.params;
    if (!ML_SITES[siteId as MLSiteCode]) {
      return res.status(400).json({ error: '无效的站点代码' });
    }
    const categories = await getCategories(siteId);
    res.json({ siteId, categories });
  } catch (error: any) {
    console.error('[ML Categories] Error:', error);
    res.status(500).json({ error: error?.message || '获取分类失败' });
  }
});

// 获取已导出的文件列表
app.get('/api/ml/files', (req, res) => {
  try {
    const files = getExportedFiles();
    res.json({ files });
  } catch (error: any) {
    console.error('[ML Files] Error:', error);
    res.status(500).json({ error: error?.message || '获取文件列表失败' });
  }
});

// 删除已导出的文件
app.delete('/api/ml/files/:filename', (req, res) => {
  try {
    const { filename } = req.params;
    if (!filename || typeof filename !== 'string') {
      return res.status(400).json({ success: false, error: '文件名无效' });
    }
    const exportDir = path.join(__dirname, '..', 'data', 'exports');
    const filePath = path.join(exportDir, filename);

    // 安全检查：防止路径穿越（仅允许删除 exports 目录内的文件）
    if (!filePath.startsWith(exportDir) || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(403).json({ success: false, error: '无效的文件路径' });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: '文件不存在' });
    }

    fs.unlinkSync(filePath);
    console.log(`[ML Files] 已删除导出文件: ${filename}`);
    res.json({ success: true, message: `已删除 ${filename}` });
  } catch (error: any) {
    console.error('[ML Files] Delete Error:', error);
    res.status(500).json({ success: false, error: error?.message || '删除失败' });
  }
});

// 下载导出文件
app.get('/api/ml/download/:filename', (req, res) => {
  try {
    const { filename } = req.params;
    const exportDir = path.join(__dirname, '..', 'data', 'exports');
    const filePath = path.join(exportDir, filename);

    // 安全检查：防止路径穿越
    if (!filePath.startsWith(exportDir)) {
      return res.status(403).json({ error: '无效的文件路径' });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: '文件不存在' });
    }

    res.download(filePath, filename);
  } catch (error: any) {
    console.error('[ML Download] Error:', error);
    res.status(500).json({ error: error?.message || '下载失败' });
  }
});

// 图片代理：代理下载 ML 图片（解决跨域下载问题）
app.get('/api/ml/image-proxy', (req, res) => {
  try {
    const imageUrl = req.query.url as string;
    if (!imageUrl) {
      return res.status(400).json({ error: '缺少 url 参数' });
    }
    // 安全检查：仅允许 https 链接，且只允许 ML/ML CDN 域名
    const allowed = /^https?:\/\/(http2\.mlstatic\.com|mlstatic\.com|www\.mercadolibre\.\w+|.*\.mlstatic\.com)/i;
    if (!allowed.test(imageUrl)) {
      return res.status(403).json({ error: '不允许的图片源' });
    }
    const client = imageUrl.startsWith('https') ? https : http;
    client.get(imageUrl, (proxyRes) => {
      if (proxyRes.statusCode !== 200) {
        return res.status(proxyRes.statusCode || 502).json({ error: '图片获取失败' });
      }
      const ct = proxyRes.headers['content-type'] || 'image/jpeg';
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Content-Disposition', `attachment; filename="product_image.${ct.split('/')[1] || 'jpg'}"`);
      proxyRes.pipe(res);
    }).on('error', (err) => {
      console.error('[Image Proxy] Error:', err.message);
      res.status(502).json({ error: '图片代理失败: ' + err.message });
    });
  } catch (error: any) {
    console.error('[Image Proxy] Error:', error);
    res.status(500).json({ error: error?.message || '代理失败' });
  }
});

// 获取完整 token（供前端直接调用 ML API）
app.get('/api/ml/token/full', async (req, res) => {
  await ensureValidToken();
  const token = getFullAccessToken();
  if (!token) {
    return res.status(404).json({ error: '未设置 token' });
  }
  res.json({ token });
});

// 获取回退分类列表（不调用 API，直接返回硬编码数据）
app.get('/api/ml/categories-fallback/:siteId', (req, res) => {
  const { siteId } = req.params;
  const categories = getFallbackCategories(siteId);
  res.json({ siteId, categories });
});

// ============= 代理配置端点 =============

// 获取代理配置状态
app.get('/api/ml/proxy', (req, res) => {
  res.json(getProxyConfig());
});

// 设置代理配置
app.post('/api/ml/proxy', (req, res) => {
  const { proxyUrl } = req.body;
  if (proxyUrl && typeof proxyUrl === 'string') {
    // 验证代理 URL 格式
    const trimmed = proxyUrl.trim();
    if (trimmed && !trimmed.startsWith('http://') && !trimmed.startsWith('https://') && !trimmed.startsWith('socks5://') && !trimmed.startsWith('socks4://')) {
      return res.status(400).json({ error: '代理 URL 必须以 http://、https://、socks5:// 或 socks4:// 开头' });
    }
    setProxyConfig(trimmed);
    res.json({ success: true, message: trimmed ? '代理配置已保存' : '代理已清除' });
  } else {
    // 空值 = 清除代理
    setProxyConfig('');
    res.json({ success: true, message: '代理已清除' });
  }
});

// 测试代理连通性
app.post('/api/ml/proxy/test', async (req, res) => {
  const config = getProxyConfig();
  if (!config.hasProxy) {
    return res.json({ success: false, message: '未配置代理' });
  }
  try {
    // 用一个简单的 ML API 端点测试
    const { getAccessToken, getRawProxyUrl } = await import('./mercadolibre.js');
    const token = getAccessToken();
    const testUrl = token
      ? `${'https://api.mercadolibre.com'}/users/me`
      : `${'https://api.mercadolibre.com'}/sites/MLM/categories`;

    const { HttpsProxyAgent } = await import('https-proxy-agent');
    const { SocksProxyAgent } = await import('socks-proxy-agent');

    let agent: any = undefined;
    const proxyUrl = getRawProxyUrl(); // 必须用原始（未打码）的代理 URL 建连，否则会因假密码 ***:*** 触发 407
    if (proxyUrl.startsWith('socks')) {
      agent = new SocksProxyAgent(proxyUrl);
    } else {
      agent = new HttpsProxyAgent(proxyUrl);
    }

    const https = await import('https');
    const result = await new Promise<any>((resolve, reject) => {
      const options: any = {
        hostname: 'api.mercadolibre.com',
        path: token ? '/users/me' : '/sites/MLM/categories',
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        agent,
        timeout: 15000,
      };
      const req2 = https.request(options, (resp) => {
        let data = '';
        resp.on('data', (chunk) => (data += chunk));
        resp.on('end', () => {
          resolve({ statusCode: resp.statusCode, body: data.slice(0, 300) });
        });
      });
      req2.on('error', reject);
      req2.on('timeout', () => { req2.destroy(); reject(new Error('代理请求超时')); });
      req2.end();
    });

    if (result.statusCode === 200) {
      res.json({ success: true, message: '代理连接成功！ML API 可正常访问' });
    } else {
      res.json({ success: false, message: `代理已连接，但 ML API 返回 ${result.statusCode}: ${result.body.slice(0, 100)}` });
    }
  } catch (err: any) {
    res.json({ success: false, message: `代理连接失败: ${err?.message || '未知错误'}` });
  }
});

// ============= API 代理 URL 端点（Cloudflare Worker 反向代理）=============

// 获取 API 代理 URL 状态
app.get('/api/ml/api-proxy', (req, res) => {
  res.json(getApiProxyConfig());
});

// 设置 API 代理 URL
app.post('/api/ml/api-proxy', (req, res) => {
  const { apiProxyUrl } = req.body;
  setApiProxyUrl(apiProxyUrl || '');
  res.json({ success: true, message: apiProxyUrl ? 'API 代理 URL 已保存' : 'API 代理已清除（直连模式）' });
});

// 测试 API 代理连通性
app.post('/api/ml/api-proxy/test', async (req, res) => {
  const config = getApiProxyConfig();
  if (!config.hasApiProxy) {
    return res.json({ success: false, message: '未配置 API 代理 URL' });
  }
  try {
    const proxyBase = config.apiProxyUrl;
    const { getAccessToken } = await import('./mercadolibre.js');
    const token = getAccessToken();
    if (!token) {
      return res.json({ success: false, message: '未设置 ML access token，请先获取并保存 token' });
    }
    // ML 自 2025 年起所有端点都要求 token，测试带 token 的 categories
    const testUrl = `${proxyBase}/sites/MLM/categories?access_token=${encodeURIComponent(token)}`;
    const https = await import('https');
    const result = await new Promise<any>((resolve, reject) => {
      const req2 = https.request(testUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        timeout: 15000,
      }, (resp) => {
        let data = '';
        resp.on('data', (chunk) => (data += chunk));
        resp.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ statusCode: resp.statusCode, isArray: Array.isArray(parsed), count: Array.isArray(parsed) ? parsed.length : 0, sample: JSON.stringify(parsed).slice(0, 200) });
          } catch {
            resolve({ statusCode: resp.statusCode, body: data.slice(0, 200) });
          }
        });
      });
      req2.on('error', reject);
      req2.on('timeout', () => { req2.destroy(); reject(new Error('请求超时')); });
      req2.end();
    });

    if (result.statusCode === 200 && result.count > 0) {
      res.json({ success: true, message: `API 代理连接成功！获取到 ${result.count} 个分类` });
    } else {
      res.json({ success: false, message: `API 代理返回异常: HTTP ${result.statusCode}, ${result.body || result.sample || ''}` });
    }
  } catch (err: any) {
    res.json({ success: false, message: `API 代理连接失败: ${err?.message || '未知错误'}` });
  }
});

// 前端数据导出端点（接收前端抓取的数据，导出 xlsx）
app.post('/api/ml/export', async (req, res) => {
  try {
    const { products, siteStats } = req.body;

    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: '没有商品数据' });
    }

    console.log(`[ML Export] 接收到 ${products.length} 个商品数据`);

    const result = await exportProductsToXlsx(products, siteStats || {});

    console.log(`[ML Export] 导出成功: ${result.fileName}`);

    res.json({
      success: true,
      message: `导出成功！共 ${products.length} 个商品`,
      fileName: result.fileName,
      filePath: result.filePath,
    });
  } catch (error: any) {
    console.error('[ML Export] Error:', error);
    res.status(500).json({ error: error?.message || '导出失败' });
  }
});

// 断点续传：查询是否有未完成的 checkpoint
app.get('/api/ml/checkpoint', (_req, res) => {
  const cp = loadCheckpoint();
  if (!cp) return res.json({ hasCheckpoint: false });
  // 返回精简信息，不暴露完整商品列表给前端（数据量大）
  res.json({
    hasCheckpoint: true,
    jobId: cp.jobId,
    startedAt: cp.startedAt,
    sites: cp.sites,
    completedSites: cp.completedSites,
    currentSite: cp.currentSite,
    completedCategoryIndex: cp.completedCategoryIndex,
    totalCategories: cp.totalCategories,
    productCount: cp.collectedProducts?.length || 0,
    siteStats: cp.siteStats,
  });
});

// 断点续传：清除 checkpoint
app.delete('/api/ml/checkpoint', (_req, res) => {
  deleteCheckpoint();
  res.json({ success: true });
});

// ============= 原有抓取端点（全新抓取 or 断点续传）============

// 抓取商品数据 (SSE 流式进度)
// 运行一次抓取任务（前端 /api/ml/fetch、外部 /api/ml/trigger、定时调度共用）
let lastRunSites: MLSiteCode[] = ['MLM', 'MLB'];
let lastRunOptions: FetchOptions = {};
async function runExportJob(sites: MLSiteCode[], options: FetchOptions, onProgress?: (p: any) => void, resumeCp?: FetchCheckpoint | null) {
  lastRunSites = sites;
  lastRunOptions = options;
  const result = await fetchAllProductsAndExport(sites, options, onProgress, resumeCp);
  // 抓取完成自动发邮件
  const emailCfg = getEmailConfig();
  if (emailCfg.enabled) {
    const subject = `ML Product Finder 抓取结果 (${new Date().toISOString().slice(0, 10)})`;
    const body = `本次抓取完成：共 ${result.totalCount} 个商品。\n站点统计: ${JSON.stringify(result.siteStats)}\n文件: ${result.fileName}${result.zipName ? `\n妙手素材包: ${result.zipName}` : ''}`;
    // 优先发送妙手素材包 ZIP（完整可导入），否则发送 xlsx
    const attachPath = result.zipPath || result.filePath;
    const mail = await sendXlsxResult(attachPath, subject, body);
    console.log(`[Email] ${mail.success ? '已发送' : '发送失败'}: ${mail.message}`);
  }
  return result;
}

app.post('/api/ml/fetch', async (req, res) => {
  const { sites = ['MLM', 'MLB'], options = {}, resume = false } = req.body;

  // 断点续传：加载 checkpoint 并恢复
  let resumeCp: FetchCheckpoint | null = null;
  if (resume) {
    resumeCp = loadCheckpoint();
    if (resumeCp) {
      console.log(`[ML Fetch] 断点续传: jobId=${resumeCp.jobId}, 已有 ${resumeCp.collectedProducts?.length || 0} 个商品`);
    } else {
      console.log('[ML Fetch] 请求续传但无 checkpoint，从头开始');
    }
  } else {
    // 非续传：清除旧 checkpoint
    deleteCheckpoint();
    console.log('[ML Fetch] 全新抓取，已清除旧 checkpoint');
  }

  console.log(`[ML Fetch] 开始抓取, 站点: ${sites.join(', ')}, 选项: ${JSON.stringify(options)}${resumeCp ? ', 模式: 断点续传' : ''}`);

  // 设置 SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // 禁用反向代理缓冲（Nginx / Vite 代理），保证进度实时推流
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  // 进度回调：把后端每个阶段实时写到 SSE 流
  const sendProgress = (p: any) => {
    try {
      res.write(`data: ${JSON.stringify(p)}\n\n`);
      const anyRes = res as any;
      if (typeof anyRes.flush === 'function') anyRes.flush();
    } catch { /* 连接已断开，忽略 */ }
  };

  try {
    sendProgress({ phase: 'start', current: 0, total: 0, message: resumeCp ? '正在从断点恢复...' : '正在初始化（校验 Token / 准备抓取）...' });
    await ensureValidToken();
    const result = await runExportJob(sites as MLSiteCode[], options as FetchOptions, sendProgress, resumeCp);

    res.write(`data: ${JSON.stringify({
      phase: 'complete',
      message: '抓取完成!',
      filePath: result.fileName,
      totalCount: result.totalCount,
      siteStats: result.siteStats,
    })}\n\n`);

    res.end();
  } catch (error: any) {
    console.error('[ML Fetch] Error:', error);
    res.write(`data: ${JSON.stringify({
      phase: 'error',
      message: error?.message || '抓取失败',
    })}\n\n`);
    res.end();
  }
});

// 外部触发（供 cron-job.org 等唤醒免费版 Render 并触发抓取）
app.post('/api/ml/trigger', async (req, res) => {
  const { sites = ['MLM', 'MLB'], options = {} } = req.body || {};
  console.log(`[ML Trigger] 收到触发请求`);
  // 异步运行，立即返回，避免 web 服务超时
  runExportJob(sites as MLSiteCode[], options as FetchOptions)
    .then((r) => console.log(`[ML Trigger] 抓取完成: ${r.totalCount} 个`))
    .catch((e) => console.error('[ML Trigger] 失败:', e));
  res.json({ success: true, message: '已触发后台抓取' });
});

// ============ M2：货源匹配 + 利润测算 ============
// 取 CNY→USD 汇率（用于利润测算）
app.get('/api/ml/sourcing/rate', async (req, res) => {
  try {
    const cnyUsd = await sourcing.getCnyUsdRate();
    res.json({ success: true, cnyUsd });
  } catch (err: any) {
    res.json({ success: false, message: err?.message || '获取汇率失败' });
  }
});

// 单条利润测算
app.post('/api/ml/sourcing/calc', async (req, res) => {
  try {
    const result = await sourcing.computeProfit(req.body || {});
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.json({ success: false, message: err?.message || '测算失败' });
  }
});

// 读取 M1 最新导出的爆款列表（供货源匹配/利润测算）
app.get('/api/ml/sourcing/export/latest', async (req, res) => {
  try {
    const rows = await sourcing.readLatestExportRows();
    res.json({ success: true, count: rows.length, rows });
  } catch (err: any) {
    res.json({ success: false, message: err?.message || '读取导出失败' });
  }
});

// 1688 货源匹配配置（读写方案选择 + OneBound 密钥）
app.get('/api/ml/sourcing/1688/config', (req, res) => {
  try {
    const cfg = sourcing.loadAli1688Config();
    // 不返回 oneboundSecret 原文，只返回是否有配置
    res.json({
      success: true,
      method: cfg.method || 'onebound',
      hasOneboundKey: !!cfg.oneboundKey,
      hasOneboundSecret: !!cfg.oneboundSecret,
    });
  } catch (err: any) {
    res.json({ success: false, message: err?.message || '读取配置失败' });
  }
});

app.post('/api/ml/sourcing/1688/config', (req, res) => {
  try {
    const { method, oneboundKey, oneboundSecret } = req.body || {};
    const current = sourcing.loadAli1688Config();
    if (method && ['onebound', 'search1688api'].includes(method)) {
      current.method = method;
    }
    if (oneboundKey !== undefined) current.oneboundKey = oneboundKey;
    // oneboundSecret：只有传入非空且非遮罩才更新
    if (oneboundSecret !== undefined && oneboundSecret !== '' && !oneboundSecret.startsWith('***')) {
      current.oneboundSecret = oneboundSecret;
    }
    sourcing.saveAli1688Config(current);
    res.json({ success: true, method: current.method });
  } catch (err: any) {
    res.json({ success: false, message: err?.message || '保存配置失败' });
  }
});

// 1688 自动图搜 / 货源匹配（支持两种免费方案：onebound / search1688api）
app.post('/api/ml/sourcing/1688/search', async (req, res) => {
  try {
    const { method, imageUrl, title, oneboundKey, oneboundSecret } = req.body || {};
    const result = await sourcing.search1688({ method, imageUrl, title, oneboundKey, oneboundSecret });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.json({ success: false, message: err?.message || '1688 搜索失败' });
  }
});

// 1688 免密钥自动找同款（Playwright + 本机 Edge，best-effort 关键词搜索；质量不如开放平台 API 图搜）
app.post('/api/ml/sourcing/1688/auto', async (req, res) => {
  try {
    const { keyword, title } = req.body || {};
    const q = (keyword || title || '').trim();
    if (!q) {
      return res.json({ success: false, message: '未提供搜索关键词（keyword 或 title）' });
    }
    const { autoSearch1688ByKeyword } = await import('./aliAutoSearch.js');
    const result = await autoSearch1688ByKeyword(q);
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.json({ success: false, message: err?.message || '1688 自动搜索失败' });
  }
});

// 写出含利润的 enriched xlsx（可跟卖清单）
app.post('/api/ml/sourcing/export', async (req, res) => {
  try {
    const { rows, commissionRate = 0.13, payoutRate = 0.03, roiThreshold = 0.2 } = req.body || {};
    if (!Array.isArray(rows) || rows.length === 0) {
      res.json({ success: false, message: '没有可导出的数据' });
      return;
    }
    const cnyUsd = await sourcing.getCnyUsdRate();
    const result = await sourcing.writeEnrichedExport(rows, { commissionRate, payoutRate, roiThreshold, cnyUsd });
    res.json({ success: true, fileName: result.fileName });
  } catch (err: any) {
    res.json({ success: false, message: err?.message || '导出失败' });
  }
});

// ============ M3：合规上架 ============
// 上架前合规预检（品牌黑名单 + 必填项）
app.post('/api/ml/listing/precheck', (req, res) => {
  try {
    const result = listing.precheckCompliance(req.body || {});
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.json({ success: false, message: err?.message || '预检失败' });
  }
});

// 创建 Listing（POST /items，需卖家 write token）
app.post('/api/ml/listing/create', async (req, res) => {
  try {
    await ensureValidToken();
    const result = await listing.createListing(req.body || {});
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.json({ success: false, message: err?.message || '上架失败' });
  }
});

// 批量上架（队列 + 429 指数退避重试 + 逐条合规预检）
app.post('/api/ml/listing/publish-batch', async (req, res) => {
  try {
    await ensureValidToken();
    const drafts = Array.isArray(req.body?.drafts) ? req.body.drafts : [];
    if (drafts.length === 0) {
      return res.json({ success: false, message: '未提供上架草稿（drafts 数组为空）' });
    }
    if (drafts.length > 50) {
      return res.json({ success: false, message: '单批最多 50 条，请分批上架' });
    }
    const result = await listing.publishBatch(drafts, {
      concurrency: req.body?.concurrency,
      maxRetries: req.body?.maxRetries,
    });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.json({ success: false, message: err?.message || '批量上架失败' });
  }
});

// 卖家上架配额查询（best-effort）
app.get('/api/ml/listing/quota', async (req, res) => {
  try {
    await ensureValidToken();
    const quota = await listing.getListingQuota();
    res.json({ success: true, quota });
  } catch (err: any) {
    res.json({ success: false, message: err?.message || '配额查询失败' });
  }
});

// ============ ML 热搜词 & LLM 配置 ============

// 获取站点热搜词（带 1 小时缓存）
app.get('/api/ml/trends', async (req, res) => {
  try {
    const site = (req.query.site as string) || 'MLM';
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 50);
    const keywords = await getTrendsKeywords(site, limit);
    res.json({ success: true, site, keywords, count: keywords.length });
  } catch (err: any) {
    res.json({ success: false, message: err?.message || '获取热搜失败' });
  }
});

// 完整热搜词数据（用于热搜词页面）：GET /api/ml/trends/MLM?refresh=1
app.get('/api/ml/trends/:site', async (req, res) => {
  // 翻译改为后台非阻塞补译，本接口只负责拉取热搜词（通常 1~2s），超时留足余量即可
  const TRENDS_TIMEOUT_MS = 60000;
  try {
    const site = (req.params.site as string) || 'MLM';
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 50);
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const items = await Promise.race([
      getTrends(site, limit, forceRefresh),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('获取热搜词超时，请稍后重试')), TRENDS_TIMEOUT_MS)
      ),
    ]);
    res.json({
      success: true,
      site: site.toUpperCase(),
      count: items.length,
      refreshed: forceRefresh,
      items,
    });
  } catch (err: any) {
    res.status(502).json({ success: false, message: err?.message || '获取热搜失败' });
  }
});

// 查询 LLM 配置状态（apiKey 不返回；baseUrl 仅公开服务地址，无需脱敏，必须返回完整值，
// 否则前端 loadLlmStatus 回填表单时会把截断后的地址写回输入框，再保存即损坏配置）
app.get('/api/ml/llm-config', (req, res) => {
  const cfg = getLlmConfig();
  res.json({
    success: true,
    configured: !!cfg,
    baseUrl: cfg?.baseUrl || '',
    model: cfg?.model || '',
  });
});

// 保存 LLM 配置文件（data/llm-config.json），环境变量优先级更高
app.post('/api/ml/llm-config', (req, res) => {
  try {
    const { baseUrl, apiKey, model } = req.body || {};
    if (!baseUrl || !model) {
      return res.status(400).json({ success: false, message: '请提供 baseUrl、model' });
    }
    const existing = getLlmConfig();
    // apiKey 留空表示不修改：已有配置则复用旧 key，首次保存必须提供
    const finalApiKey = (apiKey && apiKey.trim()) ? apiKey.trim() : existing?.apiKey;
    if (!finalApiKey) {
      return res.status(400).json({ success: false, message: '首次保存必须提供 apiKey' });
    }
    const result = saveLlmConfig({ baseUrl: baseUrl.replace(/\/+$/, ''), apiKey: finalApiKey, model });
    if (!result.success) {
      return res.status(400).json({ success: false, message: result.message });
    }
    res.json({ success: true, message: 'LLM 配置已保存' });
  } catch (err: any) {
    res.json({ success: false, message: err?.message || '保存失败' });
  }
});

// 测试 LLM 连通性：用 translateTrendsKeywords 翻译一个样例词，验证 baseUrl/apiKey/model 是否正确
app.post('/api/ml/llm-config/test', async (req, res) => {
  // 允许在测试请求里临时带配置（不持久化），方便未保存时先试
  const { baseUrl, apiKey, model } = req.body || {};
  if (baseUrl && apiKey && model) {
    // 先校验再临时保存；校验失败直接返回，避免把错误配置写进文件
    const normalized = baseUrl.replace(/\/+$/, '').trim();
    if (normalized.includes('...')) {
      return res.json({
        success: false,
        message: `baseUrl 不能包含省略号 "..."，你填写的是 "${normalized}"，请填写完整地址，如 https://api.siliconflow.cn`,
      });
    }
    // 临时写一遍再测（进程内生效，下一次请求仍走正式配置）
    const saveResult = saveLlmConfig({ baseUrl: normalized, apiKey, model });
    if (!saveResult.success) {
      return res.json({ success: false, message: saveResult.message });
    }
  }
  const cfg = getLlmConfig();
  if (!cfg) {
    return res.json({ success: false, message: '尚未配置 LLM（baseUrl/apiKey/model 至少一个为空）' });
  }

  // 先探测网络是否可达（不看鉴权），帮助用户区分「后端没网」和「Key/Model 错」
  const reachability = await probeLlmReachability(cfg.baseUrl, 8000);
  if (!reachability.ok) {
    return res.json({
      success: false,
      message: `后端无法访问 LLM 服务地址：${reachability.error}。请检查本机/服务器网络、代理、DNS，或换一家可访问的厂商。`,
      networkError: reachability.error,
      url: reachability.url,
      raw: '',
    });
  }

  try {
    const diag = await testLlmTranslation('MLM');
    if (diag.success && diag.sample) {
      res.json({ success: true, message: '连接成功，翻译示例：' + JSON.stringify(diag.sample), sample: diag.sample, url: reachability.url });
    } else {
      res.json({
        success: false,
        message: diag.error || '已连到模型但未返回有效翻译',
        raw: diag.raw,
        status: reachability.status,
        url: reachability.url,
      });
    }
  } catch (err: any) {
    res.json({ success: false, message: `连接失败：${err?.message || err}` });
  }
});

// 合规标题自动生成（AI 优先，规则引擎兜底）
// AI 基于 1688 货源信息 + 竞品要素 + ML 热搜词生成；AI 不可用时回退规则引擎
app.post('/api/ml/listing/generate-title', async (req, res) => {
  try {
    const { competitorTitle, site, brand, customPoints, count, maxLength, sourceTitle, sourcePriceCNY, trendKeywords } = req.body || {};
    if (!competitorTitle || typeof competitorTitle !== 'string') {
      return res.status(400).json({ success: false, message: '请提供竞品标题（competitorTitle）' });
    }

    // 1) 先尝试 AI 生成（自动注入站点热搜词）
    const aiResult = await aiGenerateTitles({
      competitorTitle,
      site: site || 'MLM',
      sourceTitle,
      sourcePriceCNY,
      brand,
      count: count || 3,
      trendKeywords: Array.isArray(trendKeywords) ? trendKeywords : undefined,
    });

    if (aiResult.titles.length > 0) {
      // 给 AI 结果也计算相似度
      const titlesWithSim = aiResult.titles.map((t) => {
        const sim = titleGen.titleSimilarity(t, competitorTitle);
        return { title: t, length: t.length, similarity: Math.round(sim * 100) / 100, safe: sim < 0.5 };
      });
      return res.json({ success: true, titles: titlesWithSim, engine: 'ai' });
    }

    // 2) AI 不可用 → 回退规则引擎
    const titles = titleGen.generateTitles({ competitorTitle, site: site || 'MLM', brand, customPoints, count, maxLength });
    res.json({ success: true, titles, engine: 'rule', aiError: aiResult.error });
  } catch (err: any) {
    res.json({ success: false, message: err?.message || '生成失败' });
  }
});

// 批量生成标题（AI 优先，规则兜底）
app.post('/api/ml/listing/generate-title/batch', async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (rows.length === 0) {
      return res.status(400).json({ success: false, message: '请提供 rows 数组' });
    }
    const { count, maxLength } = req.body;

    // 1) 先尝试 AI 批量生成（自动注入站点热搜词）
    const aiTitles = await aiGenerateTitlesBatch(
      rows.map((r: any) => ({
        competitorTitle: r.competitorTitle || r.title || '',
        site: r.site || 'MLM',
        sourceTitle: r.sourceTitle,
        sourcePriceCNY: r.sourcePriceCNY,
        brand: r.brand,
        trendKeywords: Array.isArray(r.trendKeywords) ? r.trendKeywords : undefined,
      }))
    );

    // 2) AI 未能生成的条目用规则引擎补全
    const titles: string[] = rows.map((r: any, i: number) => {
      if (aiTitles[i]) return aiTitles[i];
      const list = titleGen.generateTitles({
        competitorTitle: r.competitorTitle || r.title || '',
        site: r.site || 'MLM',
        brand: r.brand,
        count,
        maxLength,
      });
      if (!list.length) return '';
      const sorted = [...list].sort((a, b) => a.similarity - b.similarity);
      return sorted[0].title;
    });

    const aiCount = aiTitles.filter(Boolean).length;
    res.json({ success: true, titles, engine: 'ai+rule', aiGenerated: aiCount, ruleFallback: titles.length - aiCount });
  } catch (err: any) {
    res.json({ success: false, message: err?.message || '批量生成失败' });
  }
});

// ============ AI 商品描述生成 ============

// 单条描述生成
app.post('/api/ml/listing/generate-description', async (req, res) => {
  try {
    const { title, site, sourceTitle, sourcePriceCNY, competitorDescription, categoryName, brand, trendKeywords } = req.body || {};
    if (!title || typeof title !== 'string') {
      return res.status(400).json({ success: false, message: '请提供商品标题（title）' });
    }

    const result = await aiGenerateDescription({
      title,
      site: site || 'MLM',
      sourceTitle,
      sourcePriceCNY,
      competitorDescription,
      categoryName,
      brand,
      trendKeywords: Array.isArray(trendKeywords) ? trendKeywords : undefined,
    });

    if (result.description) {
      res.json({ success: true, description: result.description, engine: 'ai' });
    } else {
      // AI 失败时给一个基础模板
      const lang = (site || '').toUpperCase() === 'MLB' ? 'pt' : 'es';
      const fallback = lang === 'pt'
        ? `${title}\n\nProduto de alta qualidade. Material premium, acabamento refinado. Pronto para uso diario.\n\nEspecificacoes:\n- Produto novo\n- Qualidade garantida\n- Envio rapido`
        : `${title}\n\nProducto de alta calidad. Material premium, acabado refinado. Listo para uso diario.\n\nEspecificaciones:\n- Producto nuevo\n- Calidad garantizada\n- Envio rapido`;
      res.json({ success: true, description: fallback, engine: 'template', aiError: result.error });
    }
  } catch (err: any) {
    res.json({ success: false, message: err?.message || '描述生成失败' });
  }
});

// 批量描述生成
app.post('/api/ml/listing/generate-description/batch', async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (rows.length === 0) {
      return res.status(400).json({ success: false, message: '请提供 rows 数组' });
    }

    const descriptions = await aiGenerateDescriptionsBatch(
      rows.map((r: any) => ({
        title: r.title || r.mlTitle || '',
        site: r.site || 'MLM',
        sourceTitle: r.sourceTitle,
        sourcePriceCNY: r.sourcePriceCNY,
        competitorDescription: r.competitorDescription,
        categoryName: r.categoryName,
        brand: r.brand,
        trendKeywords: Array.isArray(r.trendKeywords) ? r.trendKeywords : undefined,
      }))
    );

    const aiCount = descriptions.filter(Boolean).length;
    res.json({ success: true, descriptions, engine: 'ai', aiGenerated: aiCount });
  } catch (err: any) {
    res.json({ success: false, message: err?.message || '批量描述生成失败' });
  }
});

// 批量配图（合规）：1688 货源图 → AI修图/水印 → 上传美客多，返回公网 URL
// 模式：ai=AI修图(去背景+白底+增强+水印) / watermark=仅水印 / direct=直传
app.post('/api/ml/listing/prepare-images', async (req, res) => {
  try {
    const { site, sourceImages, mode, watermark, watermarkText, max } = req.body || {};
    if (!Array.isArray(sourceImages) || sourceImages.length === 0) {
      return res.json({ success: false, message: '未提供 sourceImages（请先通过 1688 图搜拿到货源图）' });
    }
    // 兼容旧参数：watermark:boolean → mode:string
    const imageMode = mode || (watermark === false ? 'direct' : 'watermark');
    const result = await imagePipeline.prepareListingImages({
      site: site || 'MLM',
      sourceImages,
      mode: imageMode as any,
      watermarkText: watermarkText || 'TuTienda',
      max,
    });
    res.json({ success: result.success, ...result });
  } catch (err: any) {
    res.json({ success: false, message: err?.message || '配图失败' });
  }
});

// 检查 AI 修图能力是否可用（rembg 是否已安装）
app.get('/api/ml/listing/ai-image-status', async (req, res) => {
  try {
    const result = await imagePipeline.checkAIAvailable();
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.json({ success: false, available: false, message: err?.message });
  }
});

// ============ 完整利润引擎（参考文档版：体积重+税费+保本价+预警） ============
// 站点费率查询/覆盖
app.get('/api/ml/profit/rates', (req, res) => {
  res.json({ success: true, rates: profit.getSiteRates() });
});
app.post('/api/ml/profit/rates', (req, res) => {
  try {
    const rates = profit.saveSiteRates(req.body || {});
    res.json({ success: true, rates });
  } catch (err: any) {
    res.json({ success: false, message: err?.message || '保存费率失败' });
  }
});

// 单品完整测算
app.post('/api/ml/profit/calc', async (req, res) => {
  try {
    const result = await profit.calculateProfit(req.body || {});
    res.json({ success: true, result });
  } catch (err: any) {
    res.json({ success: false, message: err?.message || '利润测算失败' });
  }
});

// 批量完整测算
app.post('/api/ml/profit/batch', async (req, res) => {
  try {
    const inputs = Array.isArray(req.body?.inputs) ? req.body.inputs : [];
    const results = await profit.batchCalculateProfit(inputs);
    res.json({ success: true, results });
  } catch (err: any) {
    res.json({ success: false, message: err?.message || '批量测算失败' });
  }
});

// ============ 自动筛选流水线（3 层） ============
app.post('/api/ml/filter/run', async (req, res) => {
  try {
    // rows 可由前端传入（含已填货源价），不传则读 M1 最新导出
    const rows = Array.isArray(req.body?.rows) && req.body.rows.length > 0
      ? req.body.rows
      : await sourcing.readLatestExportRows();
    const result = await runFilterPipeline(rows, req.body?.config || {});
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.json({ success: false, message: err?.message || '筛选失败' });
  }
});
app.get('/api/ml/filter/config', (req, res) => {
  res.json({ success: true, config: defaultFilterConfig });
});

// ============ 选品利润分析导出（SourcingPage） ============
app.post('/api/ml/erp/export', async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) && req.body.rows.length > 0
      ? req.body.rows
      : await sourcing.readLatestExportRows();
    const result = await writeErpExport(rows, req.body?.options || {});
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.json({ success: false, message: err?.message || '利润分析导出失败' });
  }
});

// 邮件配置
app.get('/api/ml/email', (req, res) => {
  const cfg = getEmailConfig();
  res.json({ ...cfg, pass: cfg.pass ? '******' : '' });
});
app.post('/api/ml/email', (req, res) => {
  const body = { ...(req.body || {}) } as any;
  // 密码回显为 ****** 时，保留服务端已保存的真实密码，避免被覆盖
  if (body.pass === '******') {
    body.pass = getEmailConfig().pass;
  }
  const cfg = saveEmailConfig(body);
  res.json({ success: true, config: { ...cfg, pass: cfg.pass ? '******' : '' } });
});
app.post('/api/ml/email/test', async (req, res) => {
  const r = await sendTestEmail();
  res.json(r);
});

// 将历史导出文件作为附件重新发送邮件
app.post('/api/ml/email/resend', async (req, res) => {
  try {
    const { fileName } = req.body || {};
    if (!fileName || typeof fileName !== 'string') {
      return res.status(400).json({ success: false, message: '请提供文件名' });
    }
    const exportDir = path.join(__dirname, '..', 'data', 'exports');
    const filePath = path.join(exportDir, fileName);
    // 安全检查：防止路径穿越
    if (!filePath.startsWith(exportDir)) {
      return res.status(403).json({ success: false, message: '无效的文件路径' });
    }
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: '文件不存在' });
    }
    const subject = `ML Product Finder 抓取结果重发 (${new Date().toISOString().slice(0, 10)})`;
    const body = `这是历史抓取结果文件的重新发送：${fileName}`;
    const mail = await sendXlsxResult(filePath, subject, body);
    res.json(mail);
  } catch (err: any) {
    console.error('[Email Resend] Error:', err);
    res.status(500).json({ success: false, message: err?.message || '发送失败' });
  }
});

// 定时调度配置
app.get('/api/ml/schedule', (req, res) => {
  res.json(getSchedule());
});
app.post('/api/ml/schedule', (req, res) => {
  const cfg = saveSchedule(req.body || {});
  res.json({ success: true, schedule: cfg });
});

// ============= 调试端点：测试 ML API =============

app.get('/api/ml/debug/test', async (req, res) => {
  const token = getAccessToken();
  const results: Array<{ test: string; status: number; data: string }> = [];

  const tests: Array<{ test: string; url: string; useToken: boolean }> = [
    { test: '/users/me (有token)', url: 'https://api.mercadolibre.com/users/me', useToken: true },
    { test: '/sites/MLM/categories (无token)', url: 'https://api.mercadolibre.com/sites/MLM/categories', useToken: false },
    { test: '/sites/MLM/categories (有token)', url: 'https://api.mercadolibre.com/sites/MLM/categories', useToken: true },
    { test: '/sites (无token)', url: 'https://api.mercadolibre.com/sites', useToken: false },
    { test: '/sites/MLM (无token)', url: 'https://api.mercadolibre.com/sites/MLM', useToken: false },
    { test: '/sites/MLM/search?q=phone (无token)', url: 'https://api.mercadolibre.com/sites/MLM/search?q=phone&limit=3', useToken: false },
    { test: '/sites/MLM/search?q=phone (有token)', url: 'https://api.mercadolibre.com/sites/MLM/search?q=phone&limit=3', useToken: true },
    { test: '/sites/MLM/search?category=MLM1648 (有token)', url: 'https://api.mercadolibre.com/sites/MLM/search?category=MLM1648&limit=3', useToken: true },
    { test: '/items/MLM1648 (有token)', url: 'https://api.mercadolibre.com/items/MLM1648', useToken: true },
  ];

  for (const test of tests) {
    try {
      const headers: Record<string, string> = {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0.0.0 Safari/537.36',
      };
      if (test.useToken && token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const result = await new Promise<{ status: number; data: string }>((resolve, reject) => {
        const parsedUrl = new URL(test.url);
        const req = https.request({
          hostname: parsedUrl.hostname,
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'GET',
          headers,
        }, (resp) => {
          let data = '';
          resp.on('data', (chunk) => (data += chunk));
          resp.on('end', () => resolve({ status: resp.statusCode || 0, data: data.slice(0, 300) }));
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
      });

      results.push({ test: test.test, status: result.status, data: result.data });
    } catch (err: any) {
      results.push({ test: test.test, status: 0, data: err.message });
    }
  }

  res.json({ tokenPreview: token ? token.slice(0, 12) + '...' + token.slice(-4) : '(无)', results });
});

// ============= 静态文件服务 (Electron 模式) =============

// 服务前端构建产物（生产 / Electron / 或经 cloudflared 等隧道以域名方式访问时）
const distPath = process.env.ELECTRON_DIST_PATH || path.join(__dirname, '..', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
  console.log(`[Server] Serving static files from ${distPath}`);
}

// 订单轮询：间隔从 notify-config 读取，默认 30 分钟，配置变更时自动重启定时器
let orderPollTimer: NodeJS.Timeout | null = null;
function startOrderPolling() {
  if (orderPollTimer) clearInterval(orderPollTimer);
  const intervalMs = notify.getPollIntervalMs();
  orderPollTimer = setInterval(() => {
    orders.pollAllStores()
      .then((report) => {
        const triggered = report.filter((r) => (r.newOrders || 0) > 0);
        if (triggered.length) console.log('[Orders] 轮询完成，触发提醒:', JSON.stringify(triggered));
      })
      .catch((e) => console.error('[Orders] 轮询出错:', e?.message || e));
  }, intervalMs);
  const minutes = Math.round(intervalMs / 60 / 1000);
  console.log(`[Orders] 每 ${minutes} 分钟订单轮询已启动`);
}
function restartOrderPolling() {
  startOrderPolling();
}

// 启动服务器（默认 HTTP；localtunnel 会提供公网 HTTPS）
http.createServer(app).listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║                                            ║
║     ◉ API 服务器已启动 (HTTP)               ║
║                                            ║
║     地址: http://localhost:${PORT}            ║
║     数据库: SQLite (data/chat.db)          ║
║     ML API: /api/ml/*                      ║
║     OAuth 回调: /api/ml/oauth/callback     ║
║                                            ║
╚════════════════════════════════════════════╝
  `);

// 启动定时调度循环（按 /api/ml/schedule 配置在设定时间自动抓取）
startScheduler(() => runExportJob(lastRunSites, lastRunOptions));
console.log('[Scheduler] 定时调度已启动');

// 启动 token 自动续期（启动预热 + 每 30 分钟保活，依赖 ML_APP_ID/ML_SECRET_KEY）
initAutoRenew();

// 启动订单轮询（间隔从 notify-config 读取，默认 30 分钟）
startOrderPolling();
});
