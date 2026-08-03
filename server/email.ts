import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EMAIL_FILE = path.join(__dirname, '..', 'data', 'ml-email.json');

export interface EmailConfig {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  to: string;
}

let emailConfig: EmailConfig = {
  enabled: false,
  host: '',
  port: 465,
  secure: true,
  user: '',
  pass: '',
  from: '',
  to: '',
};

export function loadEmailConfig(): EmailConfig {
  try {
    if (fs.existsSync(EMAIL_FILE)) {
      const raw = fs.readFileSync(EMAIL_FILE, 'utf-8');
      emailConfig = { ...emailConfig, ...JSON.parse(raw) };
    }
  } catch (err) {
    console.error('[Email] 加载配置失败:', err);
  }
  return emailConfig;
}
loadEmailConfig();

export function saveEmailConfig(cfg: Partial<EmailConfig>): EmailConfig {
  // 跳过 undefined，避免只更新部分字段（如仅收件邮箱）时把已保存的 SMTP 密码等清空
  let changed = false;
  for (const [k, v] of Object.entries(cfg)) {
    if (v !== undefined) {
      (emailConfig as any)[k] = v;
      changed = true;
    }
  }
  if (changed) {
    try {
      fs.writeFileSync(EMAIL_FILE, JSON.stringify(emailConfig, null, 2));
    } catch (err) {
      console.error('[Email] 保存失败:', err);
    }
  }
  return emailConfig;
}

export function getEmailConfig(): EmailConfig {
  return emailConfig;
}

/**
 * 解析最终 SMTP 发件人配置：
 * 环境变量（ML_SMTP_*）优先，便于在 Render 等平台一次性配置发件人；
 * 否则回退到已保存的 ml-email.json。这样前端只需让用户填「收件邮箱」。
 */
function resolveSmtp(): { host: string; port: number; secure: boolean; user: string; pass: string; from: string } {
  return {
    host: process.env.ML_SMTP_HOST || emailConfig.host,
    port: process.env.ML_SMTP_PORT ? Number(process.env.ML_SMTP_PORT) : emailConfig.port,
    secure: process.env.ML_SMTP_SECURE ? process.env.ML_SMTP_SECURE === 'true' : emailConfig.secure,
    user: process.env.ML_SMTP_USER || emailConfig.user,
    pass: process.env.ML_SMTP_PASS || emailConfig.pass,
    from: process.env.ML_SMTP_FROM || emailConfig.from || (process.env.ML_SMTP_USER || emailConfig.user),
  };
}

/** 实际收件人：UI 填写优先，其次环境变量 ML_EMAIL_TO 兜底 */
function resolveRecipient(): string {
  return emailConfig.to || process.env.ML_EMAIL_TO || '';
}

/** 发送带 xlsx 附件的邮件（抓取结果）。调用方决定是否启用（runExportJob 已做 enabled 判断） */
export async function sendXlsxResult(filePath: string, subject: string, body: string): Promise<{ success: boolean; message: string }> {
  const smtp = resolveSmtp();
  const to = resolveRecipient();
  if (!to || !smtp.host || !smtp.user) {
    return { success: false, message: '邮件未配置（需填写收件邮箱，且服务端已配置 SMTP 发件人）' };
  }
  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: smtp.user, pass: smtp.pass },
    });
    await transporter.sendMail({
      from: smtp.from || smtp.user,
      to,
      subject,
      text: body,
      attachments: [{ filename: path.basename(filePath), path: filePath }],
    });
    return { success: true, message: `邮件已发送至 ${to}（含 xlsx 附件）` };
  } catch (err: any) {
    return { success: false, message: err?.message || '发送失败' };
  }
}

/** 测试邮件（纯文本，无附件） */
export async function sendTestEmail(): Promise<{ success: boolean; message: string }> {
  const smtp = resolveSmtp();
  const to = resolveRecipient();
  if (!to || !smtp.host || !smtp.user) {
    return { success: false, message: '邮件未配置（需填写收件邮箱，且服务端已配置 SMTP 发件人）' };
  }
  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: smtp.user, pass: smtp.pass },
    });
    await transporter.sendMail({
      from: smtp.from || smtp.user,
      to,
      subject: 'ML Product Finder - 邮件测试',
      text: '这是一封测试邮件，说明你的 SMTP 配置可用。',
    });
    return { success: true, message: `测试邮件已发送至 ${to}` };
  } catch (err: any) {
    return { success: false, message: err?.message || '发送失败' };
  }
}
