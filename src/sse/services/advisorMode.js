/**
 * Claude 顾问模式处理器
 * 
 * 工作流:
 * 1. 免费模型生成方案
 * 2. Claude 审核（只输出 1 或修改建议）
 * 3. 追踪用量，确保每小时达标
 * 4. 未达标时自动触发升级任务
 */

import { ADVISOR_SYSTEM_PROMPT, UPGRADE_CHECK_PROMPT, buildAdvisorPrompt, buildUpgradeCheckPrompt, parseAdvisorResponse } from '@/shared/constants/advisorMode.js';
import { getProviderConnections, getSettings } from '@/lib/localDb.js';

const ADVISOR_MODEL_PRIMARY = 'claude-opus-4-8';
const ADVISOR_PROVIDER_PRIMARY = 'claude';
const ADVISOR_MODEL_FALLBACK = 'kimi-for-coding';
const ADVISOR_PROVIDER_FALLBACK = 'anthropic-compatible-62f4b39b-9c36-4dd9-8a20-ac7c60ef6c0a';
const QUOTA_TARGET_PER_HOUR = 5;

/** 获取可用的顾问 provider/model */
async function getAdvisorCredentials() {
  // 尝试主顾问
  const primaryConnections = await getProviderConnections({ provider: ADVISOR_PROVIDER_PRIMARY, isActive: true });
  const primaryAvailable = primaryConnections.some(c => 
    c.testStatus === 'active' && c.apiKey && !c.errorCode
  );
  
  if (primaryAvailable) {
    return { provider: ADVISOR_PROVIDER_PRIMARY, model: ADVISOR_MODEL_PRIMARY };
  }
  
  // 降级到 Kimi
  const fallbackConnections = await getProviderConnections({ provider: ADVISOR_PROVIDER_FALLBACK, isActive: true });
  const fallbackAvailable = fallbackConnections.some(c => 
    c.testStatus === 'active' && c.apiKey && !c.errorCode
  );
  
  if (fallbackAvailable) {
    return { provider: ADVISOR_PROVIDER_FALLBACK, model: ADVISOR_MODEL_FALLBACK };
  }
  
  // 都不可用，返回主配置（让上层处理错误）
  return { provider: ADVISOR_PROVIDER_PRIMARY, model: ADVISOR_MODEL_PRIMARY };
}

/**
 * 审核方案（顾问模式）
 * @param {string} question - 问题/背景
 * @param {string} freeModelOutput - 免费模型生成的方案
 * @param {Function} executeRequest - 执行请求的函数
 * @returns {{ approved: boolean, feedback: string|null }}
 */
export async function reviewWithAdvisor(question, freeModelOutput, executeRequest) {
  const settings = await getSettings();
  if (settings.localFeaturesEnabled === false) {
    return { approved: true, feedback: null };
  }

  const { provider, model } = await getAdvisorCredentials();
  
  const prompt = buildAdvisorPrompt(question, freeModelOutput);
  
  console.log('[ADVISOR]', `审核请求: ${question.slice(0, 50)}... (advisor: ${provider}/${model})`);
  
  const response = await executeRequest({
    provider,
    model,
    messages: [
      { role: 'system', content: ADVISOR_SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ],
    max_tokens: 50
  });
  
  const result = parseAdvisorResponse(response);
  console.log('[ADVISOR]', `审核结果: ${result.approved ? '通过' : '需修改'} (${provider}/${model})`);
  
  return result;
}

/**
 * 检查系统升级需求（顾问模式）
 * @param {string} systemStatus - 系统状态报告
 * @param {Function} executeRequest - 执行请求的函数
 * @returns {{ met: boolean, task: string|null }}
 */
export async function checkUpgradeNeed(systemStatus, executeRequest) {
  const settings = await getSettings();
  if (settings.localFeaturesEnabled === false) {
    return { met: true, task: null };
  }

  const { provider, model } = await getAdvisorCredentials();
  
  const prompt = buildUpgradeCheckPrompt(systemStatus);
  
  console.log('[ADVISOR]', `检查升级需求... (advisor: ${provider}/${model})`);
  
  const response = await executeRequest({
    provider,
    model,
    messages: [
      { role: 'system', content: UPGRADE_CHECK_PROMPT },
      { role: 'user', content: prompt }
    ],
    max_tokens: 100
  });
  
  const result = parseAdvisorResponse(response);
  console.log('[ADVISOR]', `升级检查: ${result.approved ? '达标' : '需升级'} (${provider}/${model})`);
  
  return {
    met: result.approved,
    task: result.feedback
  };
}

/**
 * 追踪顾问用量
 */
export class AdvisorQuotaTracker {
  constructor() {
    this.requests = [];
  }
  
  recordRequest() {
    this.requests.push(Date.now());
  }
  
  /**
   * 检查本小时是否达标
   */
  checkHourlyQuota() {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const recentRequests = this.requests.filter(t => t > oneHourAgo);
    return {
      count: recentRequests.length,
      met: recentRequests.length >= QUOTA_TARGET_PER_HOUR,
      target: QUOTA_TARGET_PER_HOUR
    };
  }
  
  /**
   * 获取需要生成的升级任务数量
   */
  getUpgradeTasksNeeded() {
    const { count, target } = this.checkHourlyQuota();
    return Math.max(0, target - count);
  }
}

// 全局实例
export const advisorQuota = new AdvisorQuotaTracker();
