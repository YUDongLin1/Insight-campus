/**
 * 校园情报官 Insight Campus - 零依赖后端服务
 *
 * 运行方式：
 *   1. 复制 .env.example 为 .env，按需填入腾讯云密钥
 *   2. node server.js
 *   3. 浏览器访问 http://localhost:3001
 *
 * 说明：
 *   - 不把 SecretKey 放到浏览器，前端只请求本后端。
 *   - 已修复腾讯云 TC3-HMAC-SHA256 签名：timestamp 使用 Unix 秒级时间戳，date 使用 UTC yyyy-mm-dd。
 *   - 未配置密钥时自动走 Mock，方便路演演示。
 *   - 支持 OpenAI/Anthropic 兼容的 API 格式，可在 AI 控制台配置。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 3001);
const APP_TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Shanghai';
const MOCK_MODE = (process.env.MOCK_MODE || 'auto').toLowerCase(); // auto | force

const TENCENT = {
  secretId: process.env.TENCENT_SECRET_ID || '',
  secretKey: process.env.TENCENT_SECRET_KEY || '',
  region: process.env.TENCENT_REGION || 'ap-guangzhou',
  hunyuanEndpoint: 'hunyuan.tencentcloudapi.com',
  hunyuanService: 'hunyuan',
  hunyuanVersion: '2023-09-01',
  hunyuanAction: 'ChatCompletions',
  hunyuanModel: process.env.HUNYUAN_MODEL || 'hunyuan-turbos-latest',
  ocrEndpoint: 'ocr.tencentcloudapi.com',
  ocrService: 'ocr',
  ocrVersion: '2018-11-19',
  ocrAction: 'GeneralBasicOCR'
};

let lastProviderError = '';

// ==================== AI 配置管理（支持 OpenAI/Anthropic 兼容格式）====================
const AI_CONFIG_FILE = path.join(__dirname, 'ai-config.json');

// 默认配置
let aiConfig = {
  provider: 'tencent', // tencent | openai | anthropic | openai-compatible
  // OpenAI 兼容
  openaiApiKey: '',
  openaiBaseURL: 'https://api.openai.com/v1',
  openaiModel: 'gpt-3.5-turbo',
  // Anthropic
  anthropicApiKey: '',
  anthropicBaseURL: 'https://api.anthropic.com',
  anthropicModel: 'claude-3-haiku-20240307',
  // 自定义 OpenAI 兼容
  customBaseURL: '',
  customApiKey: '',
  customModel: '',
  // 智谱 BigModel
  zhipuApiKey: process.env.BIGMODEL_API_KEY || process.env.ZHIPU_API_KEY || '',
  zhipuBaseURL: process.env.BIGMODEL_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
  zhipuModel: process.env.BIGMODEL_MODEL || 'glm-4.7',
  zhipuVisionModel: process.env.BIGMODEL_VISION_MODEL || 'glm-4.5v',
  // 腾讯混元（可从 .env 或页面配置）
  tencentSecretId: '',
  tencentSecretKey: '',
  tencentModel: 'hunyuan-turbos-latest'
};

// 加载 AI 配置
function loadAIConfig() {
  try {
    if (fs.existsSync(AI_CONFIG_FILE)) {
      const data = fs.readFileSync(AI_CONFIG_FILE, 'utf8');
      const saved = JSON.parse(data);
      aiConfig = { ...aiConfig, ...saved };
    }
  } catch (error) {
    console.error('加载 AI 配置失败:', error.message);
  }
  // 如果 .env 中有腾讯云密钥，优先使用
  if (TENCENT.secretId && TENCENT.secretKey) {
    aiConfig.tencentSecretId = TENCENT.secretId;
    aiConfig.tencentSecretKey = TENCENT.secretKey;
    aiConfig.tencentModel = TENCENT.hunyuanModel;
  }
  if (process.env.BIGMODEL_API_KEY || process.env.ZHIPU_API_KEY) {
    aiConfig.zhipuApiKey = process.env.BIGMODEL_API_KEY || process.env.ZHIPU_API_KEY;
    aiConfig.zhipuBaseURL = process.env.BIGMODEL_BASE_URL || aiConfig.zhipuBaseURL;
    aiConfig.zhipuModel = process.env.BIGMODEL_MODEL || aiConfig.zhipuModel;
    aiConfig.zhipuVisionModel = process.env.BIGMODEL_VISION_MODEL || aiConfig.zhipuVisionModel;
  }
}

// 保存 AI 配置
function saveAIConfig(newConfig) {
  // 过滤掉不应保存的字段
  const toSave = { ...newConfig };
  aiConfig = { ...aiConfig, ...toSave };
  try {
    fs.writeFileSync(AI_CONFIG_FILE, JSON.stringify(aiConfig, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('保存 AI 配置失败:', error.message);
    return false;
  }
}

// 检查是否有任何 AI 提供商配置
function isAnyAIConfigured() {
  if (MOCK_MODE === 'force') return false;
  if (aiConfig.provider === 'tencent') {
    return Boolean(aiConfig.tencentSecretId && aiConfig.tencentSecretKey);
  }
  if (aiConfig.provider === 'openai') {
    return Boolean(aiConfig.openaiApiKey);
  }
  if (aiConfig.provider === 'anthropic') {
    return Boolean(aiConfig.anthropicApiKey);
  }
  if (aiConfig.provider === 'openai-compatible') {
    return Boolean(aiConfig.customBaseURL && aiConfig.customApiKey);
  }
  if (aiConfig.provider === 'zhipu') {
    return Boolean(aiConfig.zhipuApiKey);
  }
  return false;
}

// 获取配置状态（不返回敏感信息）
function getConfigStatus() {
  return {
    provider: aiConfig.provider,
    configured: isAnyAIConfigured(),
    // OpenAI 兼容
    openaiBaseURL: aiConfig.openaiBaseURL,
    openaiModel: aiConfig.openaiModel,
    openaiConfigured: Boolean(aiConfig.openaiApiKey),
    // Anthropic
    anthropicBaseURL: aiConfig.anthropicBaseURL,
    anthropicModel: aiConfig.anthropicModel,
    anthropicConfigured: Boolean(aiConfig.anthropicApiKey),
    // 自定义兼容
    customBaseURL: aiConfig.customBaseURL,
    customModel: aiConfig.customModel,
    customConfigured: Boolean(aiConfig.customBaseURL && aiConfig.customApiKey),
    // 智谱 BigModel
    zhipuBaseURL: aiConfig.zhipuBaseURL,
    zhipuModel: aiConfig.zhipuModel,
    zhipuVisionModel: aiConfig.zhipuVisionModel,
    zhipuConfigured: Boolean(aiConfig.zhipuApiKey),
    // 腾讯混元
    tencentConfigured: Boolean(aiConfig.tencentSecretId && aiConfig.tencentSecretKey),
    tencentModel: aiConfig.tencentModel || TENCENT.hunyuanModel
  };
}

loadAIConfig();

function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    value = value.replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function isTencentConfigured() {
  const id = TENCENT.secretId.trim();
  const key = TENCENT.secretKey.trim();
  if (MOCK_MODE === 'force') return false;
  return Boolean(id && key && !id.includes('your_') && !key.includes('your_'));
}

function nowInChinaText() {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date());
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmacSha256(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest(encoding);
}

/**
 * 腾讯云 API 3.0 签名 v3。
 * 注意：Content-Type、Host、X-TC-Action 必须和实际请求头一致。
 */
function buildTencentHeaders({ action, service, endpoint, version, region, payload }) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const date = new Date(Number(timestamp) * 1000).toISOString().slice(0, 10);
  const httpRequestMethod = 'POST';
  const canonicalUri = '/';
  const canonicalQueryString = '';
  const contentType = 'application/json; charset=utf-8';
  const canonicalHeaders = [
    `content-type:${contentType}`,
    `host:${endpoint}`,
    `x-tc-action:${action.toLowerCase()}`,
    ''
  ].join('\n');
  const signedHeaders = 'content-type;host;x-tc-action';
  const hashedRequestPayload = sha256Hex(payload);
  const canonicalRequest = [
    httpRequestMethod,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    hashedRequestPayload
  ].join('\n');

  const algorithm = 'TC3-HMAC-SHA256';
  const credentialScope = `${date}/${service}/tc3_request`;
  const hashedCanonicalRequest = sha256Hex(canonicalRequest);
  const stringToSign = [algorithm, timestamp, credentialScope, hashedCanonicalRequest].join('\n');

  const secretDate = hmacSha256(`TC3${TENCENT.secretKey}`, date);
  const secretService = hmacSha256(secretDate, service);
  const secretSigning = hmacSha256(secretService, 'tc3_request');
  const signature = hmacSha256(secretSigning, stringToSign, 'hex');
  const authorization = `${algorithm} Credential=${TENCENT.secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    Authorization: authorization,
    'Content-Type': contentType,
    Host: endpoint,
    'X-TC-Action': action,
    'X-TC-Version': version,
    'X-TC-Timestamp': timestamp,
    'X-TC-Region': region
  };
}

async function callTencentApi({ action, service, endpoint, version, payloadObj }) {
  if (!isTencentConfigured()) throw new Error('腾讯云密钥未配置，当前使用 Mock 模式');
  if (typeof fetch !== 'function') throw new Error('当前 Node.js 版本不支持 fetch，请使用 Node.js 18 或更高版本');

  const payload = JSON.stringify(payloadObj);
  const headers = buildTencentHeaders({
    action,
    service,
    endpoint,
    version,
    region: TENCENT.region,
    payload
  });

  const response = await fetch(`https://${endpoint}/`, {
    method: 'POST',
    headers,
    body: payload
  });

  const responseText = await response.text();
  let data;
  try {
    data = JSON.parse(responseText);
  } catch (error) {
    throw new Error(`腾讯云返回非 JSON 内容：HTTP ${response.status} ${responseText.slice(0, 160)}`);
  }

  if (!response.ok || data.Response?.Error) {
    const err = data.Response?.Error;
    const message = err ? `${err.Code}: ${err.Message}` : `HTTP ${response.status}: ${responseText.slice(0, 240)}`;
    throw new Error(message);
  }

  return data.Response;
}

async function callHunyuan(messages, options = {}) {
  const payloadObj = {
    Model: options.model || TENCENT.hunyuanModel,
    Messages: messages
      .filter(item => item && item.Role && item.Content)
      .map(item => ({ Role: item.Role, Content: item.Content })),
    Stream: false,
    Temperature: options.temperature ?? 0.35,
    TopP: options.topP ?? 0.8
  };

  const response = await callTencentApi({
    action: TENCENT.hunyuanAction,
    service: TENCENT.hunyuanService,
    endpoint: TENCENT.hunyuanEndpoint,
    version: TENCENT.hunyuanVersion,
    payloadObj
  });

  const content = response?.Choices?.[0]?.Message?.Content;
  if (!content) throw new Error('混元响应中没有 Choices[0].Message.Content');
  return content.trim();
}

// ==================== OpenAI 兼容 API 调用 ====================
async function callOpenAICompatible(messages, options = {}) {
  const apiKey = aiConfig.openaiApiKey;
  const baseURL = aiConfig.openaiBaseURL || 'https://api.openai.com/v1';
  const model = options.model || aiConfig.openaiModel || 'gpt-3.5-turbo';

  if (!apiKey) throw new Error('OpenAI API Key 未配置');
  if (typeof fetch !== 'function') throw new Error('当前 Node.js 版本不支持 fetch，请使用 Node.js 18 或更高版本');

  // 转换消息格式（腾讯云格式转 OpenAI 格式）
  const openAIMessages = messages
    .filter(item => item && item.Role && item.Content)
    .map(item => ({
      role: item.Role === 'assistant' ? 'assistant' : 'user',
      content: item.Content
    }));

  const payload = {
    model,
    messages: openAIMessages,
    temperature: options.temperature ?? 0.35,
    top_p: options.topP ?? 0.8,
    stream: false
  };

  const response = await fetch(`${baseURL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    const message = data.error?.message || `HTTP ${response.status}: ${JSON.stringify(data.error || {})}`;
    throw new Error(`OpenAI API 错误: ${message}`);
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI 响应中没有 choices[0].message.content');
  return content.trim();
}

// ==================== Anthropic API 调用 ====================
async function callAnthropic(messages, options = {}) {
  const apiKey = aiConfig.anthropicApiKey;
  const baseURL = aiConfig.anthropicBaseURL || 'https://api.anthropic.com';
  const model = options.model || aiConfig.anthropicModel || 'claude-3-haiku-20240307';

  if (!apiKey) throw new Error('Anthropic API Key 未配置');
  if (typeof fetch !== 'function') throw new Error('当前 Node.js 版本不支持 fetch，请使用 Node.js 18 或更高版本');

  // 转换消息格式，提取 system prompt
  let systemPrompt = '';
  const anthropicMessages = [];

  for (const item of messages) {
    if (!item || !item.Role || !item.Content) continue;
    if (item.Role === 'system') {
      systemPrompt = item.Content;
    } else {
      anthropicMessages.push({
        role: item.Role === 'assistant' ? 'assistant' : 'user',
        content: item.Content
      });
    }
  }

  const payload = {
    model,
    messages: anthropicMessages,
    system: systemPrompt || undefined,
    temperature: options.temperature ?? 0.35,
    top_p: options.topP ?? 0.8,
    max_tokens: options.maxTokens || 1024,
    stream: false
  };

  const response = await fetch(`${baseURL.replace(/\/+$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    const message = data.error?.message || `HTTP ${response.status}: ${JSON.stringify(data.error || {})}`;
    throw new Error(`Anthropic API 错误: ${message}`);
  }

  const content = data.content?.[0]?.text;
  if (!content) throw new Error('Anthropic 响应中没有 content[0].text');
  return content.trim();
}

// ==================== 自定义 OpenAI 兼容 API 调用 ====================
async function callCustomCompatible(messages, options = {}) {
  const apiKey = aiConfig.customApiKey;
  let baseURL = aiConfig.customBaseURL;
  const model = options.model || aiConfig.customModel || '';

  if (!baseURL) throw new Error('自定义 API Base URL 未配置');
  if (!apiKey) throw new Error('自定义 API Key 未配置');
  if (!model && !options.model) throw new Error('自定义 Model 未配置');

  // 智能处理 Base URL，确保路径正确
  baseURL = baseURL.replace(/\/+$/, '');  // 移除末尾的斜杠
  
  // 如果 URL 不包含 /v1 或 /v2 等 API 版本路径，自动添加 /v1
  // 这是 OpenAI 兼容 API 的常见格式（包括 Deepseek）
  if (!baseURL.match(/\/[vV]\d+/)) {
    // 检查是否是已知的 API 提供商
    if (baseURL.includes('deepseek') || baseURL.includes('openai')) {
      // OpenAI 和 Deepseek 使用 /v1 路径
      baseURL += '/v1';
    }
    // 其他提供商保持原样，让用户自己配置完整路径
  }

  // 转换消息格式
  const openAIMessages = messages
    .filter(item => item && item.Role && item.Content)
    .map(item => ({
      role: item.Role === 'assistant' ? 'assistant' : 'user',
      content: item.Content
    }));

  const payload = {
    model,
    messages: openAIMessages,
    temperature: options.temperature ?? 0.35,
    top_p: options.topP ?? 0.8,
    stream: false
  };

  const apiURL = `${baseURL}/chat/completions`;
  console.log(`[Custom API] 调用 URL: ${apiURL}`);  // 调试日志

  const response = await fetch(apiURL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    const message = data.error?.message || `HTTP ${response.status}: ${JSON.stringify(data.error || {})}`;
    throw new Error(`自定义 API 错误: ${message}`);
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('自定义 API 响应中没有 choices[0].message.content');
  return content.trim();
}

function normalizeBigModelBaseURL(baseURL) {
  let url = (baseURL || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
  if (!/\/api\/paas\/v\d+$/i.test(url)) {
    if (/bigmodel|zhipu/i.test(url)) url += '/api/paas/v4';
  }
  return url;
}

async function callZhipuChat(messages, options = {}) {
  const apiKey = aiConfig.zhipuApiKey;
  const baseURL = normalizeBigModelBaseURL(aiConfig.zhipuBaseURL);
  const model = options.model || aiConfig.zhipuModel || 'glm-4.7';

  if (!apiKey) throw new Error('智谱 BigModel API Key 未配置');
  if (typeof fetch !== 'function') throw new Error('当前 Node.js 版本不支持 fetch，请使用 Node.js 18 或更高版本');

  const zhipuMessages = messages
    .filter(item => item && item.Role && item.Content)
    .map(item => ({
      role: item.Role === 'assistant' ? 'assistant' : item.Role === 'system' ? 'system' : 'user',
      content: item.Content
    }));

  const payload = {
    model,
    messages: zhipuMessages,
    temperature: options.temperature ?? 0.35,
    top_p: options.topP ?? 0.8,
    stream: false
  };
  if (options.maxTokens) payload.max_tokens = options.maxTokens;

  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    const message = data.error?.message || `HTTP ${response.status}: ${JSON.stringify(data.error || {})}`;
    throw new Error(`智谱 BigModel 错误: ${message}`);
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('智谱 BigModel 响应中没有 choices[0].message.content');
  return typeof content === 'string' ? content.trim() : JSON.stringify(content);
}

function splitImageDataURL(imageBase64) {
  const raw = String(imageBase64 || '');
  const match = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (match) return { mime: match[1], base64: match[2] };
  return { mime: 'image/jpeg', base64: raw.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '') };
}

async function callZhipuVisionOcr(imageBase64) {
  const apiKey = aiConfig.zhipuApiKey;
  const baseURL = normalizeBigModelBaseURL(aiConfig.zhipuBaseURL);
  const model = aiConfig.zhipuVisionModel || 'glm-4.5v';
  const { base64 } = splitImageDataURL(imageBase64);
  if (!apiKey) throw new Error('智谱 BigModel API Key 未配置');
  if (!base64) throw new Error('图片内容为空');

  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '你是校园海报/截图识别器。请同时完成 OCR 和图片理解，提取图片里所有可见文字、活动主题、时间、地点、报名方式、截止日期、主办方和重要视觉线索。只返回严格 JSON：{"ocrText":"保留换行的可见文字","visualSummary":"基于图片内容补充的简短描述","confidence":"high|medium|low"}'
            },
            {
              type: 'image_url',
              image_url: {
                url: base64
              }
            }
          ]
        }
      ],
      temperature: 0.1,
      top_p: 0.8,
      stream: false
    })
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    const message = data.error?.message || `HTTP ${response.status}: ${JSON.stringify(data.error || {})}`;
    throw new Error(`智谱视觉识别失败: ${message}`);
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('智谱视觉模型没有返回内容');

  try {
    const parsed = safeJsonParse(content);
    const text = [parsed.ocrText, parsed.visualSummary].filter(Boolean).join('\n\n图片理解：').trim();
    if (!text) throw new Error('视觉模型未识别出有效内容');
    return { text, raw: content, parsed };
  } catch (_) {
    const text = String(content || '').trim();
    if (!text) throw new Error('视觉模型未识别出有效内容');
    return { text, raw: content, parsed: null };
  }
}

// ==================== 统一 AI 调用接口 ====================
async function callConfiguredAI(messages, options = {}) {
  const provider = aiConfig.provider || 'tencent';

  try {
    if (provider === 'openai') {
      return await callOpenAICompatible(messages, options);
    } else if (provider === 'anthropic') {
      return await callAnthropic(messages, options);
    } else if (provider === 'openai-compatible') {
      return await callCustomCompatible(messages, options);
    } else if (provider === 'zhipu') {
      return await callZhipuChat(messages, options);
    } else {
      // 默认使用腾讯混元
      return await callHunyuan(messages, options);
    }
  } catch (error) {
    lastProviderError = error.message;
    throw error;
  }
}

async function callTencentOcr(imageBase64) {
  const cleanBase64 = String(imageBase64 || '').replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
  if (!cleanBase64) throw new Error('图片内容为空');

  const response = await callTencentApi({
    action: TENCENT.ocrAction,
    service: TENCENT.ocrService,
    endpoint: TENCENT.ocrEndpoint,
    version: TENCENT.ocrVersion,
    payloadObj: { ImageBase64: cleanBase64 }
  });

  const text = (response.TextDetections || [])
    .map(item => item.DetectedText)
    .filter(Boolean)
    .join('\n')
    .trim();

  if (!text) throw new Error('OCR 未识别出文字');
  return text;
}

// 使用 OCR.space 免费 OCR 服务（后备方案）
async function callOcrSpace(imageBase64) {
  const cleanBase64 = String(imageBase64 || '').replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
  if (!cleanBase64) throw new Error('图片内容为空');

  console.log('[OCR] 使用 OCR.space 免费服务');
  
  const response = await fetch('https://api.ocr.space/parse/image', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      base64Image: `data:image/jpeg;base64,${cleanBase64}`,
      language: 'chs',
      isOverlayRequired: 'false',
      detectOrientation: 'true',
      scale: 'true',
      OCREngine: '2' // 使用引擎2（更准确）
    })
  });

  const data = await response.json();
  
  if (!data.IsErroredOnProcessing && data.ParsedResults) {
    const text = data.ParsedResults.map(result => result.ParsedText).join('\n').trim();
    if (!text) throw new Error('OCR 未识别出文字');
    return text;
  }
  
  // 如果 OCR.space 失败，抛出错误
  const errorMsg = data.ErrorMessage || data.ErrorDetails || 'OCR.space 识别失败';
  throw new Error(errorMsg);
}

const TYPE_LABEL = {
  recruit: '招聘/宣讲',
  lecture: '讲座/学术',
  contest: '比赛/项目',
  assignment: '作业/DDL',
  meeting: '会议/社团',
  activity: '校园活动',
  internship: '实习/内推',
  notice: '通知',
  general: '通用信息'
};

function detectType(text) {
  const s = text.toLowerCase();
  if (/(宣讲|招聘|校招|面试|内推|offer|实习)/i.test(s)) return 'recruit';
  if (/(讲座|报告|论坛|学术|论文|seminar|workshop)/i.test(s)) return 'lecture';
  if (/(比赛|大赛|竞赛|项目|路演|答辩|hackathon)/i.test(s)) return 'contest';
  if (/(作业|ddl|deadline|截止|提交|实验报告|课程论文)/i.test(s)) return 'assignment';
  if (/(例会|会议|班会|组会|社团|部门会)/i.test(s)) return 'meeting';
  if (/(活动|招新|志愿|晚会|观影|运动会)/i.test(s)) return 'activity';
  return 'general';
}

function extractFirstMatch(text, patterns, fallback = '待确认') {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return String(match[1] || match[0]).replace(/[，。；;\n]+$/g, '').trim();
  }
  return fallback;
}

function extractTime(text) {
  return extractFirstMatch(text, [
    /(\d{4}[年\/-]\d{1,2}[月\/-]\d{1,2}[日号]?\s*(?:周[一二三四五六日天])?\s*(?:上午|下午|晚上|中午)?\s*\d{1,2}[点:：]\d{0,2})/,
    /(\d{1,2}月\d{1,2}[日号]?\s*(?:周[一二三四五六日天])?\s*(?:上午|下午|晚上|中午)?\s*\d{1,2}(?:[:：]\d{2}|点半|点)?)/,
    /((?:本周|下周)?周[一二三四五六日天]\s*(?:上午|下午|晚上|中午)?\s*\d{1,2}(?:[:：]\d{2}|点半|点)?)/,
    /((?:今天|今晚|明天|后天)\s*(?:上午|下午|晚上|中午)?\s*\d{1,2}(?:[:：]\d{2}|点半|点)?)/,
    /(截止(?:时间)?[:：]?\s*[^，。；;\n]+)/,
    /(ddl[:：]?\s*[^，。；;\n]+)/i
  ]);
}

function extractLocation(text) {
  return extractFirstMatch(text, [
    /(?:地点|地址|会议室|教室)[:：]\s*([^，。；;\n]+)/,
    /(?:在|于)\s*([^，。；;\n]*(?:大活|活动中心|报告厅|教室|会议室|实验室|图书馆|教学楼|学院|线上|腾讯会议|Zoom|Tencent Meeting)[^，。；;\n]*)/i,
    /([^，。；;\n]*(?:\d{3,4}|A\d+|B\d+|C\d+)[^，。；;\n]*(?:教室|会议室|报告厅|室)?)/i,
    /(线上(?:提交|会议)?|腾讯会议[:：]?\s*\d*)/i
  ]);
}

function extractTitle(text, type) {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*[【\[]?通知[】\]]?\s*/, '').trim())
    .filter(Boolean);

  const keywordLine = lines.find(line => /(宣讲|招聘|讲座|比赛|大赛|作业|DDL|截止|例会|活动|通知|招新)/i.test(line));
  const raw = keywordLine || lines[0] || TYPE_LABEL[type] || '校园信息';
  const cleaned = raw
    .replace(/^(各位同学|同学们|大家好)[，,：:]?\s*/, '')
    .replace(/(?:时间|地点|地址)[:：].*$/g, '')
    .split(/[，,。；;\n]/)[0]
    .trim();
  return cleaned.slice(0, 42) || TYPE_LABEL[type] || '校园信息';
}

function buildRuleInsight(type, task) {
  const mapping = {
    recruit: {
      title: '把宣讲会从"路过通知"变成"可执行求职计划"',
      summary: '建议提前拆解岗位 JD，准备一段 60 秒项目介绍，并把宣讲会后的问答沉淀到 QQ 频道精华区；如果目标是 PCG 方向，可重点突出内容产品理解、用户增长和 AI 工具实践。',
      prep: ['准备一段 STAR 项目经历', '记录岗位关键词和投递入口', '宣讲后 24 小时内完成简历迭代'],
      pcg: ['QQ 频道：沉淀宣讲问答与组队投递', '腾讯新闻：补充行业背景', '腾讯混元：模拟面试追问']
    },
    lecture: {
      title: '把讲座变成可复用的知识卡片',
      summary: '讲座前先列 3 个问题，讲座中记录关键词，结束后用 AI 生成一页式总结，沉淀到随身笔记；适合后续论文选题、课程展示和社团分享。',
      prep: ['提前浏览主讲人方向', '准备 3 个问题', '结束后整理 5 条可引用观点'],
      pcg: ['腾讯文档：自动生成讲座纪要', '腾讯新闻：延展技术热点', 'QQ 频道：发起同好讨论']
    },
    contest: {
      title: '把比赛 DDL 拆成"组队-脑暴-提交"的节奏',
      summary: '建议先确定目标用户与可验证痛点，再把方案拆为原型、演示脚本和提交材料三条线；每条线设置里程碑，避免最后一天同时赶产品和 PPT。',
      prep: ['明确 1 个具体校园痛点', '准备 3 分钟演示脚本', '把提交物拆成日历待办'],
      pcg: ['QQ 频道：找队友与收集反馈', '腾讯文档：多人脑暴和路演稿', '腾讯混元：生成用户故事与评审问答']
    },
    assignment: {
      title: '把 DDL 从"焦虑提醒"变成"可拆解任务"',
      summary: '建议按资料收集、初稿、检查、提交四步拆分，每步预留缓冲时间；对课程论文或实验报告，可先用 AI 生成提纲，再人工校验事实与引用。',
      prep: ['拆分为 4 个子任务', '预留 20% 缓冲时间', '提交前做格式和附件检查'],
      pcg: ['腾讯文档：协作编辑', 'QQ 提醒：同步小组进度', 'AI 助手：生成检查清单']
    },
    meeting: {
      title: '把社团/班级会议变成有产出的行动清单',
      summary: '会议前明确议题，会议中记录负责人和截止时间，会议后自动同步到日历；这样能减少群聊反复 @，也方便新人快速了解上下文。',
      prep: ['会前确认议题', '会中记录负责人', '会后同步行动项'],
      pcg: ['QQ 频道：会议纪要与任务分发', '腾讯文档：多人协作记录', 'AI 助手：提炼行动项']
    },
    general: {
      title: '把碎片通知转成结构化校园情报',
      summary: '当前通知已经被整理为主题、时间、地点和建议事项。建议将重要事件同步到日历，并把背景信息沉淀为笔记，减少群聊刷屏造成的遗漏。',
      prep: ['确认时间地点', '同步到日历', '必要时转发给同伴'],
      pcg: ['QQ：分发与讨论', '腾讯文档：沉淀资料', '腾讯混元：提炼摘要']
    }
  };
  const item = mapping[type] || mapping.general;
  return {
    title: item.title,
    summary: item.summary,
    preparation: item.prep,
    pcgMapping: item.pcg,
    shareCard: {
      title: task.topic,
      subtitle: `${task.time} · ${task.location}`,
      bullets: item.prep.slice(0, 3)
    }
  };
}

function ruleAnalyze(text) {
  const type = detectType(text);
  const task = {
    topic: extractTitle(text, type),
    time: extractTime(text),
    location: extractLocation(text),
    type,
    typeLabel: TYPE_LABEL[type],
    priority: ['recruit', 'contest', 'assignment'].includes(type) ? 'high' : 'medium',
    actionItems: []
  };

  const insight = buildRuleInsight(type, task);
  task.actionItems = insight.preparation;

  return {
    ok: true,
    source: 'mock-rule',
    type,
    task,
    news: {
      title: insight.title,
      summary: insight.summary,
      preparation: insight.preparation,
      pcgMapping: insight.pcgMapping
    },
    shareCard: insight.shareCard,
    rawText: text
  };
}

function safeJsonParse(modelText) {
  const cleaned = String(modelText || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('模型没有返回 JSON 对象');
    return JSON.parse(match[0]);
  }
}

function normalizeAnalyzeResult(parsed, rawText, source) {
  const fallback = ruleAnalyze(rawText);
  const type = parsed.type || parsed.task?.type || fallback.type;
  const task = {
    topic: parsed.task?.topic || parsed.title || fallback.task.topic,
    time: parsed.task?.time || parsed.time || fallback.task.time,
    location: parsed.task?.location || parsed.location || fallback.task.location,
    type,
    typeLabel: TYPE_LABEL[type] || parsed.task?.typeLabel || fallback.task.typeLabel,
    priority: parsed.task?.priority || fallback.task.priority,
    actionItems: Array.isArray(parsed.task?.actionItems) && parsed.task.actionItems.length
      ? parsed.task.actionItems.slice(0, 5)
      : fallback.task.actionItems
  };

  return {
    ok: true,
    source,
    type,
    task,
    news: {
      title: parsed.news?.title || parsed.insight_title || fallback.news.title,
      summary: parsed.news?.summary || parsed.insight_content || fallback.news.summary,
      preparation: Array.isArray(parsed.news?.preparation) ? parsed.news.preparation.slice(0, 5) : task.actionItems,
      pcgMapping: Array.isArray(parsed.news?.pcgMapping) ? parsed.news.pcgMapping.slice(0, 5) : fallback.news.pcgMapping
    },
    shareCard: parsed.shareCard || fallback.shareCard,
    rawText
  };
}

async function analyzeText(text) {
  const cleanText = String(text || '').trim();
  if (!cleanText) throw httpError(400, '请提供需要解析的校园通知文本');
  if (cleanText.length > 8000) throw httpError(400, '文本过长，请控制在 8000 字以内');

  const fallback = ruleAnalyze(cleanText);
  if (!isAnyAIConfigured()) return fallback;

  const provider = aiConfig.provider || 'tencent';
  const sourceLabel = provider === 'openai' ? 'openai' : provider === 'anthropic' ? 'anthropic' : provider === 'openai-compatible' ? 'custom-api' : provider === 'zhipu' ? 'zhipu-bigmodel' : 'tencent-hunyuan';

  const systemPrompt = `你是"校园情报官 Insight Campus"的 AI 解析引擎，服务对象是中国高校学生。\n当前时间：${nowInChinaText()}。\n请把用户输入的群聊通知、海报 OCR 文本、DDL 或活动描述，转成可执行的校园情报。\n必须只返回严格 JSON，不要 Markdown，不要解释，不要代码块。\n字段结构如下：\n{\n  "type": "recruit|lecture|contest|assignment|meeting|activity|internship|notice|general",\n  "task": {\n    "topic": "活动或任务标题，不超过32字",\n    "time": "尽量标准化的时间；不确定写待确认",\n    "location": "地点；不确定写待确认",\n    "priority": "high|medium|low",\n    "actionItems": ["3到5条学生下一步行动"]\n  },\n  "news": {\n    "title": "洞察标题",\n    "summary": "120到180字，说明活动价值、风险、准备建议，要贴近校园真实场景",\n    "preparation": ["3到5条准备建议"],\n    "pcgMapping": ["结合 QQ/QQ频道/腾讯新闻/腾讯文档/腾讯视频/腾讯混元等场景的产品化联动建议"]\n  },\n  "shareCard": {\n    "title": "可分享卡片标题",\n    "subtitle": "时间地点摘要",\n    "bullets": ["3条适合分享到QQ群或QQ频道的信息"]\n  }\n}`;

  try {
    const modelText = await callConfiguredAI([
      { Role: 'system', Content: systemPrompt },
      { Role: 'user', Content: cleanText }
    ]);
    const parsed = safeJsonParse(modelText);
    lastProviderError = '';
    return normalizeAnalyzeResult(parsed, cleanText, sourceLabel);
  } catch (error) {
    lastProviderError = error.message;
    return {
      ...fallback,
      source: 'mock-rule-after-provider-error',
      providerError: error.message
    };
  }
}

function mockChatReply(question) {
  const q = String(question || '').toLowerCase();
  if (/(通知|整理|今天)/.test(q)) {
    return '我建议按"紧急 DDL / 高价值活动 / 可忽略通知"三层整理。你可以把群聊内容粘到情报中心，我会提取时间地点、生成行动项并同步日历。';
  }
  if (/(搭子|组队|队友|学习)/.test(q)) {
    return '可以从共同日程、兴趣标签、可投入时间三个维度匹配搭子。比如创意大赛可以优先找"懂前端 + 懂校园运营 + 会讲故事"的同学。';
  }
  if (/(比赛|创意|大赛|pcg)/.test(q)) {
    return '这个赛题最关键的是"具体、可验证、能接入 PCG 场景"。建议你把痛点收敛到校园群聊信息过载，再用 QQ 频道、腾讯新闻、腾讯文档和混元形成闭环。';
  }
  if (/(面试|校招|简历)/.test(q)) {
    return '建议用"场景痛点 → 用户验证 → AI 能力 → PCG 生态 → 商业/增长指标"讲项目。面试时重点强调你如何把 AI 从功能做成产品闭环。';
  }
  return '收到。我可以帮你把校园信息拆成任务、洞察、日历提醒和可分享卡片。把具体通知贴给我，效果会更准确。';
}

async function chat(question, history = []) {
  const cleanQuestion = String(question || '').trim();
  if (!cleanQuestion) throw httpError(400, '问题不能为空');
  if (!isAnyAIConfigured()) return { ok: true, source: 'mock-rule', reply: mockChatReply(cleanQuestion) };

  const provider = aiConfig.provider || 'tencent';
  const sourceLabel = provider === 'openai' ? 'openai' : provider === 'anthropic' ? 'anthropic' : provider === 'openai-compatible' ? 'custom-api' : provider === 'zhipu' ? 'zhipu-bigmodel' : 'tencent-hunyuan';

  const systemPrompt = '你是校园情报官的随身 AI 助手。回答要简洁、产品化、贴近中国大学生，不要编造具体学校事实。';
  const recentHistory = Array.isArray(history) ? history.slice(-8) : [];
  const messages = [
    { Role: 'system', Content: systemPrompt },
    ...recentHistory.map(item => ({
      Role: item.role === 'ai' || item.role === 'assistant' ? 'assistant' : 'user',
      Content: String(item.text || item.content || '')
    })).filter(item => item.Content),
    { Role: 'user', Content: cleanQuestion }
  ];

  try {
    const reply = await callConfiguredAI(messages, { temperature: 0.55, topP: 0.9 });
    lastProviderError = '';
    return { ok: true, source: sourceLabel, reply };
  } catch (error) {
    lastProviderError = error.message;
    return { ok: true, source: 'mock-rule-after-provider-error', reply: mockChatReply(cleanQuestion), providerError: error.message };
  }
}

function mockInterview(content, answer) {
  if (!answer) {
    return '如果你是校园情报官的产品经理，请用 1 分钟说明：这个产品解决的具体校园痛点是什么？为什么必须结合 QQ 频道、腾讯新闻/文档和大模型来做？';
  }
  if (answer.length < 30) {
    return '回答方向是对的，但信息量偏少。建议补充：目标用户是谁、原来流程有多低效、AI 介入后减少了哪些步骤，以及你会用什么指标验证效果。';
  }
  if (/数据|指标|留存|转化|效率|验证/.test(answer)) {
    return '不错，你已经提到验证意识。可以再进一步：给出一个最小可行实验，例如在 2 个班级 QQ 群测试一周，比较通知遗漏率、日历同步率和卡片分享率。';
  }
  return '表达比较完整。建议用"痛点-方案-生态-验证"四段式收束，并把 PCG 业务联动讲得更具体：QQ 频道负责分发，腾讯新闻提供背景，腾讯文档沉淀内容，混元负责结构化理解。';
}

async function interview(content, answer = '', history = []) {
  const baseContext = String(content || '校园情报官 AI 产品创意大赛 Demo').slice(0, 4000);
  const cleanAnswer = String(answer || '').trim();
  if (!isAnyAIConfigured()) return { ok: true, source: 'mock-rule', reply: mockInterview(baseContext, cleanAnswer) };

  const provider = aiConfig.provider || 'tencent';
  const sourceLabel = provider === 'openai' ? 'openai' : provider === 'anthropic' ? 'anthropic' : provider === 'openai-compatible' ? 'custom-api' : provider === 'zhipu' ? 'zhipu-bigmodel' : 'tencent-hunyuan';

  const systemPrompt = '你是腾讯 PCG 校园 AI 产品创意大赛评审兼模拟面试官。请围绕产品定位、用户痛点、PCG 生态结合、AI 能力、验证指标进行专业追问或点评。回答不超过180字。';
  const userPrompt = cleanAnswer
    ? `项目背景：${baseContext}\n候选人回答：${cleanAnswer}\n请给出面试点评，并追问一个更深入的问题。`
    : `项目背景：${baseContext}\n请生成一个适合开场的专业面试问题。`;

  try {
    const reply = await callConfiguredAI([
      { Role: 'system', Content: systemPrompt },
      ...((Array.isArray(history) ? history.slice(-6) : []).map(item => ({
        Role: item.role === 'ai' || item.role === 'assistant' ? 'assistant' : 'user',
        Content: String(item.text || item.content || '')
      })).filter(item => item.Content)),
      { Role: 'user', Content: userPrompt }
    ], { temperature: 0.5, topP: 0.85 });
    lastProviderError = '';
    return { ok: true, source: sourceLabel, reply };
  } catch (error) {
    lastProviderError = error.message;
    return { ok: true, source: 'mock-rule-after-provider-error', reply: mockInterview(baseContext, cleanAnswer), providerError: error.message };
  }
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function readJson(req, maxBytes = 15 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        reject(httpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (_) {
        reject(httpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  const payload = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(text);
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const decoded = decodeURIComponent(safePath);
  const filePath = path.normalize(path.join(__dirname, decoded));
  if (!filePath.startsWith(__dirname)) return sendText(res, 403, 'Forbidden');

  fs.readFile(filePath, (error, data) => {
    if (error) return sendText(res, 404, 'Not Found');
    const ext = path.extname(filePath).toLowerCase();
    const typeMap = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.md': 'text/markdown; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml; charset=utf-8'
    };
    res.writeHead(200, { 'Content-Type': typeMap[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

async function route(req, res) {
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  try {
    if (req.method === 'GET' && pathname === '/api/health') {
      const configStatus = getConfigStatus();
      const modelName = configStatus.provider === 'zhipu'
        ? `${configStatus.zhipuModel} / ${configStatus.zhipuVisionModel}`
        : configStatus.provider === 'openai'
          ? configStatus.openaiModel
          : configStatus.provider === 'anthropic'
            ? configStatus.anthropicModel
            : configStatus.provider === 'openai-compatible'
              ? configStatus.customModel
              : configStatus.tencentModel;
      return sendJson(res, 200, {
        ok: true,
        service: 'Insight Campus API',
        apiConfigured: configStatus.configured,
        provider: configStatus.provider,
        mode: configStatus.configured ? configStatus.provider : 'mock-rule',
        model: modelName || '',
        mockMode: MOCK_MODE,
        lastProviderError,
        time: new Date().toISOString(),
        config: configStatus
      });
    }

    if (req.method === 'POST' && pathname === '/api/analyze') {
      const body = await readJson(req);
      const text = body.content || body.text || '';
      return sendJson(res, 200, await analyzeText(text));
    }

    if (req.method === 'POST' && pathname === '/api/analyze-image') {
      const body = await readJson(req, 18 * 1024 * 1024);
      const imageBase64 = body.imageBase64 || body.image || '';
      if (!imageBase64) throw httpError(400, '请提供 imageBase64');

      let ocrText = '';
      let ocrSource = '';
      let visionRaw = '';

      // 优先使用智谱 BigModel 多模态模型：同时识别文字和图片内容。
      if (aiConfig.zhipuApiKey && MOCK_MODE !== 'force') {
        try {
          const vision = await callZhipuVisionOcr(imageBase64);
          ocrText = vision.text;
          visionRaw = vision.raw;
          ocrSource = 'zhipu-vision';
        } catch (error) {
          console.log('[OCR] 智谱 BigModel 视觉识别失败，尝试传统 OCR:', error.message);
        }
      }

      // 传统 OCR 后备：腾讯云 OCR
      if (!ocrText && isTencentConfigured()) {
        try {
          ocrText = await callTencentOcr(imageBase64);
          ocrSource = 'tencent';
        } catch (error) {
          console.log('[OCR] 腾讯云 OCR 失败，尝试 OCR.space:', error.message);
        }
      }

      // 如果腾讯云 OCR 失败或未配置，尝试 OCR.space
      if (!ocrText && MOCK_MODE !== 'force') {
        try {
          ocrText = await callOcrSpace(imageBase64);
          ocrSource = 'ocrspace';
        } catch (error) {
          console.log('[OCR] OCR.space 也失败:', error.message);
        }
      }

      // 如果所有 OCR 都失败
      if (!ocrText) {
        const result = ruleAnalyze('海报/截图上传：OCR 识别失败。请手动粘贴海报文字内容。');
        result.task.topic = '海报识别失败';
        result.task.time = '请手动输入';
        result.task.location = '请手动输入';
        result.news.title = 'OCR 识别失败';
        result.news.summary = '智谱多模态识别和传统 OCR 均不可用。请手动复制海报文字内容，然后粘贴到文本框中进行解析。';
        result.source = 'mock-image-ocr-failed';
        result.ocrFailed = true;
        return sendJson(res, 200, result);
      }

      // OCR 成功，进行 AI 分析
      try {
        const result = await analyzeText(ocrText);
        result.ocrText = ocrText;
        result.ocrSource = ocrSource;
        if (visionRaw) result.visionRaw = visionRaw;
        return sendJson(res, 200, result);
      } catch (error) {
        lastProviderError = error.message;
        const result = ruleAnalyze('海报 OCR 成功，但 AI 分析失败：' + error.message);
        result.source = 'mock-image-after-ai-error';
        result.providerError = error.message;
        result.ocrText = ocrText;
        result.ocrSource = ocrSource;
        if (visionRaw) result.visionRaw = visionRaw;
        return sendJson(res, 200, result);
      }
    }

    if (req.method === 'POST' && pathname === '/api/chat') {
      const body = await readJson(req);
      return sendJson(res, 200, await chat(body.question || body.content || '', body.history || []));
    }

    if (req.method === 'POST' && pathname === '/api/interview') {
      const body = await readJson(req);
      return sendJson(res, 200, await interview(body.content || '', body.answer || '', body.history || []));
    }

    // ==================== AI 配置相关 API ====================
    if (req.method === 'GET' && pathname === '/api/config') {
      return sendJson(res, 200, {
        ok: true,
        ...getConfigStatus()
      });
    }

    if (req.method === 'POST' && pathname === '/api/config') {
      const body = await readJson(req);
      const saved = saveAIConfig(body);
      if (saved) {
        return sendJson(res, 200, { ok: true, message: '配置已保存', ...getConfigStatus() });
      } else {
        throw httpError(500, '保存配置失败');
      }
    }

    if (req.method === 'POST' && pathname === '/api/config/test') {
      const body = await readJson(req);
      const testProvider = body.provider || aiConfig.provider;

      try {
        let testResult = '';
        if (testProvider === 'openai') {
          // 测试 OpenAI API
          const response = await fetch(`${ (body.openaiBaseURL || 'https://api.openai.com/v1').replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${body.openaiApiKey || aiConfig.openaiApiKey}`
            },
            body: JSON.stringify({
              model: body.openaiModel || aiConfig.openaiModel || 'gpt-3.5-turbo',
              messages: [{ role: 'user', content: 'Hello' }],
              max_tokens: 10
            })
          });
          const data = await response.json();
          if (!response.ok || data.error) {
            throw new Error(data.error?.message || `HTTP ${response.status}`);
          }
          testResult = 'OpenAI API 连接成功';
        } else if (testProvider === 'anthropic') {
          // 测试 Anthropic API
          const response = await fetch(`${ (body.anthropicBaseURL || 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/messages`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': body.anthropicApiKey || aiConfig.anthropicApiKey,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: body.anthropicModel || aiConfig.anthropicModel || 'claude-3-haiku-20240307',
              messages: [{ role: 'user', content: 'Hello' }],
              max_tokens: 10
            })
          });
          const data = await response.json();
          if (!response.ok || data.error) {
            throw new Error(data.error?.message || `HTTP ${response.status}`);
          }
          testResult = 'Anthropic API 连接成功';
        } else if (testProvider === 'openai-compatible') {
          // 测试自定义兼容 API
          let testBaseURL = body.customBaseURL || aiConfig.customBaseURL;
          if (!testBaseURL) throw new Error('自定义 API Base URL 未配置');
          
          // 智能处理 Base URL（与 callCustomCompatible 逻辑一致）
          testBaseURL = testBaseURL.replace(/\/+$/, '');
          if (!testBaseURL.match(/\/[vV]\d+/)) {
            if (testBaseURL.includes('deepseek') || testBaseURL.includes('openai')) {
              testBaseURL += '/v1';
            }
          }
          
          const response = await fetch(`${testBaseURL}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${body.customApiKey || aiConfig.customApiKey}`
            },
            body: JSON.stringify({
              model: body.customModel || aiConfig.customModel,
              messages: [{ role: 'user', content: 'Hello' }],
              max_tokens: 10
            })
          });
          const data = await response.json();
          if (!response.ok || data.error) {
            throw new Error(data.error?.message || `HTTP ${response.status}`);
          }
          testResult = '自定义 API 连接成功';
        } else if (testProvider === 'zhipu') {
          const testBaseURL = normalizeBigModelBaseURL(body.zhipuBaseURL || aiConfig.zhipuBaseURL);
          const response = await fetch(`${testBaseURL}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${body.zhipuApiKey || aiConfig.zhipuApiKey}`
            },
            body: JSON.stringify({
              model: body.zhipuModel || aiConfig.zhipuModel || 'glm-4.7',
              messages: [{ role: 'user', content: 'Hello' }],
              max_tokens: 10,
              stream: false
            })
          });
          const data = await response.json();
          if (!response.ok || data.error) {
            throw new Error(data.error?.message || `HTTP ${response.status}`);
          }
          testResult = '智谱 BigModel 连接成功';
        } else {
          // 测试腾讯混元
          if (!body.tencentSecretId && !aiConfig.tencentSecretId) throw new Error('腾讯云密钥未配置');
          testResult = '腾讯云密钥格式正确（注：完整测试需要实际调用）';
        }
        return sendJson(res, 200, { ok: true, message: testResult });
      } catch (error) {
        return sendJson(res, 200, { ok: false, error: error.message });
      }
    }

    if (req.method === 'GET' && !pathname.startsWith('/api/')) {
      return serveStatic(req, res, pathname);
    }

    sendJson(res, 404, { ok: false, error: '接口不存在' });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    const configStatus = getConfigStatus();
    sendJson(res, statusCode, {
      ok: false,
      error: error.message || '服务异常',
      mode: configStatus.configured ? configStatus.provider : 'mock-rule'
    });
  }
}

const server = http.createServer(route);
server.listen(PORT, () => {
  const configStatus = getConfigStatus();
  const mode = configStatus.configured ? `AI 控制台已配置（${configStatus.provider}）` : 'Mock 演示模式（可在 AI 控制台配置）';
  console.log(`\n🎓 校园情报官 Insight Campus 已启动`);
  console.log(`   前端地址: http://localhost:${PORT}`);
  console.log(`   健康检查: http://localhost:${PORT}/api/health`);
  console.log(`   AI 控制台: http://localhost:${PORT}（侧边栏 -> AI 控制台）`);
  console.log(`   当前模式: ${mode}`);
  console.log(`   提示: 现在可以在前端 AI 控制台配置 OpenAI/Anthropic/腾讯混元等 API。\n`);
});
