// SillyTavern 1.14 exposes live module bindings instead of the newer helpers.
export function generationStatus(core, groups) {
  if (typeof core.isGenerating === 'function') return () => Boolean(core.isGenerating());
  if (typeof core.is_send_press !== 'boolean' || typeof groups?.is_group_generating !== 'boolean') {
    throw new Error('酒馆缺少生成状态接口，请使用 SillyTavern 1.14.0 或兼容版本。');
  }
  return () => Boolean(core.is_send_press || groups.is_group_generating
    || (core.streamingProcessor && !core.streamingProcessor.isFinished && !core.streamingProcessor.isStopped));
}

export function worldInfoNames(context, worldInfo) {
  const names = typeof context.getWorldInfoNames === 'function' ? context.getWorldInfoNames() : worldInfo?.world_names;
  if (!Array.isArray(names)) throw new Error('世界书列表尚未就绪，请稍后刷新资料。');
  return [...names];
}

// 1.14's presetToGeneratePayload only returns temperature. Build an isolated
// request from its public settings; never switch or mutate the host's preset.
// Field names follow public/scripts/openai.js at the official 1.14.0 tag.
export function legacyChatPayload(context, preset, overrides) {
  const s = context.chatCompletionSettings;
  const source = s?.chat_completion_source;
  const supported = ['openai', 'claude', 'openrouter', 'ai21', 'makersuite', 'vertexai', 'mistralai',
    'custom', 'cohere', 'perplexity', 'groq', 'electronhub', 'nanogpt', 'deepseek', 'aimlapi',
    'xai', 'pollinations', 'moonshot', 'fireworks', 'cometapi', 'azure_openai', 'zai', 'siliconflow'];
  if (!supported.includes(source)) throw new Error('旧版酒馆的当前连接类型无法读取，请改用独立 API。');
  const payload = { ...overrides, messages: structuredClone(overrides.messages), type: 'quiet', chat_completion_source: source,
    user_name: context.name1, char_name: context.name2, group_names: [],
    include_reasoning: Boolean(s.show_thoughts), reasoning_effort: s.reasoning_effort,
    enable_web_search: Boolean(s.enable_web_search), request_images: Boolean(s.request_images),
    custom_prompt_post_processing: s.custom_prompt_post_processing || '' };
  const number = (field, setting, fallback) => {
    const value = Number(preset?.[field] ?? s[setting] ?? fallback);
    if (!Number.isFinite(value)) throw new Error(`酒馆生成参数 ${field} 无效。`);
    return value;
  };
  payload.temperature = number('temperature', 'temp_openai', 1);
  payload.top_p = number('top_p', 'top_p_openai', 1);
  payload.frequency_penalty = number('frequency_penalty', 'freq_pen_openai', 0);
  payload.presence_penalty = number('presence_penalty', 'pres_pen_openai', 0);
  const copy = (...fields) => { for (const field of fields) if (s[field] !== undefined) payload[field] = structuredClone(s[field]); };
  if (s.reverse_proxy && ['claude', 'openai', 'mistralai', 'makersuite', 'vertexai', 'deepseek', 'xai'].includes(source)) {
    copy('reverse_proxy', 'proxy_password');
  }
  if (source === 'custom') copy('custom_url', 'custom_include_body', 'custom_exclude_body', 'custom_include_headers');
  if (source === 'azure_openai') copy('azure_base_url', 'azure_deployment_name', 'azure_api_version');
  if (['claude', 'openrouter', 'makersuite', 'vertexai', 'cohere', 'perplexity', 'electronhub'].includes(source)) {
    payload.top_k = number('top_k', 'top_k_openai', 0);
  }
  if (source === 'claude') payload.claude_use_sysprompt = s.claude_use_sysprompt ?? true;
  if (['makersuite', 'vertexai'].includes(source)) payload.use_makersuite_sysprompt = s.use_makersuite_sysprompt ?? true;
  if (source === 'vertexai') copy('vertexai_auth_mode', 'vertexai_region', 'vertexai_express_project_id');
  if (source === 'openrouter') {
    for (const field of ['min_p', 'top_a', 'repetition_penalty']) payload[field] = number(field, `${field}_openai`, field === 'repetition_penalty' ? 1 : 0);
    for (const [field, setting] of Object.entries({ use_fallback: 'openrouter_use_fallback', provider: 'openrouter_providers', allow_fallbacks: 'openrouter_allow_fallbacks', middleout: 'openrouter_middleout' })) {
      if (s[setting] !== undefined) payload[field] = structuredClone(s[setting]);
    }
  }
  if (source === 'mistralai') payload.safe_prompt = false;
  if (source === 'cohere') {
    payload.top_p = Math.min(Math.max(payload.top_p, 0.01), 0.99);
    for (const key of ['frequency_penalty', 'presence_penalty']) payload[key] = Math.min(Math.max(payload[key], 0), 1);
  }
  if (source === 'deepseek') payload.top_p ||= Number.EPSILON;
  if (source === 'pollinations') delete payload.max_tokens;
  if (source === 'zai') {
    payload.top_p ||= 0.01;
    copy('zai_endpoint');
    delete payload.frequency_penalty; delete payload.presence_penalty;
  }
  if (source === 'xai') {
    const model = String(payload.model || '');
    if (!model.includes('grok-3-mini')) delete payload.reasoning_effort;
    if (/grok-3-mini|grok-4|grok-code/.test(model)) { delete payload.frequency_penalty; delete payload.presence_penalty; }
  }
  if (['openai', 'azure_openai'].includes(source)) {
    const model = String(payload.model || '');
    if (/^(o1|o3|o4|gpt-5)/.test(model)) {
      payload.max_completion_tokens = payload.max_tokens; delete payload.max_tokens;
      if (!model.includes('gpt-5-chat-latest')) {
        delete payload.frequency_penalty; delete payload.presence_penalty;
        if (!model.startsWith('gpt-5.1')) { delete payload.temperature; delete payload.top_p; }
      }
    }
    if (model.startsWith('o1')) for (const message of payload.messages) if (message.role === 'system') message.role = 'user';
    if (['o1', 'o1-2024-12-17'].includes(model)) payload.stream = false;
    if (source === 'azure_openai' && /^gpt-[34]/.test(model)) delete payload.reasoning_effort;
  }
  return payload;
}

export async function chatPayload(context, preset, overrides) {
  const payload = await context.ChatCompletionService.presetToGeneratePayload(preset || {}, {}, overrides);
  if (payload?.chat_completion_source && Array.isArray(payload.messages)) return payload;
  return legacyChatPayload(context, preset, overrides);
}
