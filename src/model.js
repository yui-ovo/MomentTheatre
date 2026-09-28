import { recoverStoryTitle } from './story-title.js';
import { normalizeStickers } from './phone-format.js';
import { DEFAULT_STICKERS } from './default-stickers.js';
import { normalizeRegexRules } from './preset-regex.js';
import { captureReadingTheme, resolveTheme, resolveLegacyTheme, validateTheme, BUILTIN_THEMES, THEME_ALIASES, RETIRED_THEME_IDS } from './themes.js';

import { createId } from './id.js';

export const VERSION = '1.0.15';
export const normalizeMode = mode => ['prose', 'phone', 'html'].includes(mode) ? mode : 'prose';
export const modeLabel = mode => ({ prose: '正文', phone: '小手机', html: 'HTML' }[mode] || '正文');
export const SCHEMA = 1;
export const id = createId;
export const clone = value => structuredClone(value);
export const text = (value, max = 1000000) => typeof value === 'string' ? value.slice(0, max) : '';
export const unique = values => [...new Set(values)];
export const clamp = (value, min, max, fallback) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback;
export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'day', apiMode: 'main', endpoint: '', model: '', character: '', persona: '', books: [], preset: '',
  readContext: false, contextCount: 10, words: 5000, targetMessages: 50, maxTokens: 60000, stream: true, regexPresets: {}, regexCharacters: {}, bookCharacter: '', characterBooks: {},
  proseTheme: 'prose-stamp', phoneTheme: 'phone-light', launcherEnabled: true, launcher: { x: null, y: null }, models: [], modelsEndpoint: '',
  personaMode: 'current', customPersonaName: '', customPersonaDescription: '', presetOverrides: {}, bookOverrides: {}, stickers: DEFAULT_STICKERS, stickerCatalogVersion: 2, stickerDraft: null,
});
export function emptyState() {
  return { schemaVersion: SCHEMA, themeCatalogVersion: 1, settings: clone(DEFAULT_SETTINGS), categories: [], stories: [], themes: [], errors: [], editorDraft: null, draft: { prompt: '', mode: 'prose' } };
}
export function newStory({ title, prompt, mode, themeId, snapshot }) {
  return { id: id(), title: text(title, 120) || '未命名番外', prompt: text(prompt), mode: normalizeMode(mode),
    themeId, snapshot: clone(snapshot), chapters: [], categoryIds: [], tags: [], saved: false,
    continuationDraft: '', continuationMode: mode === 'html' ? '' : normalizeMode(mode), summaries: [], createdAt: Date.now(), updatedAt: Date.now() };
}
export function appendChapter(story, { content, instruction = '', complete = true, mode = story.mode, themeId = story.themeId, readingTheme = null, wordCount = 0, targetWords = 0, messageCount = 0, targetMessages = 0, sourceContent = '', readingRegex = [] }) {
  if (!text(content).trim()) throw new Error('没有可保存的生成内容。');
  if ((story.mode === 'html' || mode === 'html') && (story.mode !== 'html' || mode !== 'html' || story.chapters.length)) throw new Error('HTML 作品独立保存，不支持续写或混合章节。');
  const last = story.chapters.at(-1);
  if (last && !last.complete) throw new Error('请先整理未完成的最后一节，再继续续写。');
  story.chapters.push({ id: id(), content: text(content), sourceContent: text(sourceContent), readingRegex: normalizeRegexRules(readingRegex), instruction: text(instruction), complete, mode, themeId, readingTheme: mode !== 'html' && readingTheme ? captureReadingTheme(readingTheme, mode) : null, wordCount, targetWords, messageCount, targetMessages, createdAt: Date.now() });
  story.continuationMode = mode === 'html' ? '' : mode;
  story.updatedAt = Date.now();
  return story;
}
export function invalidateSummaries(story, chapterIndex) {
  story.summaries = (story.summaries || []).filter(s => s.through <= chapterIndex);
}
export function removeCategory(state, categoryId) {
  state.categories = state.categories.filter(c => c.id !== categoryId);
  for (const story of state.stories) story.categoryIds = story.categoryIds.filter(c => c !== categoryId);
}
export function filterStories(state, { category = 'all', tag = '', query = '' } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  return state.stories.filter(s => s.saved)
    .filter(s => category === 'all' || (category === 'uncategorized' ? s.categoryIds.length === 0 : s.categoryIds.includes(category)))
    .filter(s => !tag || s.tags.includes(tag))
    .filter(s => !needle || `${s.title}\n${s.prompt}\n${s.tags.join(' ')}`.toLocaleLowerCase().includes(needle))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
function assert(condition, message) { if (!condition) throw new Error(message); }
function list(value, max, label) { assert(Array.isArray(value) && value.length <= max, `${label}格式或数量不正确。`); return value; }
function safeId(value) { assert(typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value), '资料中的标识格式不正确。'); return value; }
function strings(value, max = 1000) { return unique(list(value ?? [], max, '列表').map(v => text(v, 200)).filter(Boolean)); }
export function normalizeState(raw) {
  assert(raw && typeof raw === 'object' && raw.schemaVersion === SCHEMA, '此资料版本不受当前插件支持，请更新插件；原数据未覆盖。');
  const state = emptyState();
  const s = raw.settings ?? {};
  for (const key of ['endpoint', 'model', 'character', 'persona', 'preset', 'proseTheme', 'phoneTheme']) state.settings[key] = text(s[key], 2000) || DEFAULT_SETTINGS[key];
  state.settings.theme = s.theme === 'night' ? 'night' : 'day';
  state.settings.apiMode = s.apiMode === 'independent' ? 'independent' : 'main';
  state.settings.books = strings(s.books);
  state.settings.bookCharacter = text(s.bookCharacter, 2000);
  state.settings.characterBooks = Object.fromEntries(Object.entries(s.characterBooks || {}).slice(0, 1000).map(([key, value]) => [key, { selected:strings(value?.selected), linked:strings(value?.linked) }]));
  for (const field of ['regexPresets', 'regexCharacters']) state.settings[field] = Object.fromEntries(Object.entries(s[field] || {}).slice(0, 1000).map(([name, config]) => [name, {
    selected: strings(config.selected, 200),
    edits: Object.fromEntries(Object.entries(config.edits || {}).slice(0, 200).map(([key, rule]) => [key, normalizeRegexRules([{ ...rule, id: key }])[0]])),
  }]));
  state.settings.stickers = normalizeStickers(s.stickers);
  if (![1,2].includes(s.stickerCatalogVersion)) {
    const existing = new Set(state.settings.stickers.map(row => row.name.trim()));
    state.settings.stickers.push(...clone(DEFAULT_STICKERS.filter(row => !existing.has(row.name))));
  }
  state.settings.stickerCatalogVersion = s.stickerCatalogVersion === 2 ? 2 : 1;
  if (s.stickerDraft && typeof s.stickerDraft === 'object') {
    const item = normalizeStickers([s.stickerDraft.item])[0];
    const index = Number.isInteger(s.stickerDraft.index) && s.stickerDraft.index >= 0 && s.stickerDraft.index < state.settings.stickers.length ? s.stickerDraft.index : null;
    state.settings.stickerDraft = { index, item };
  }
  state.settings.personaMode = s.personaMode === 'custom' ? 'custom' : 'current';
  state.settings.customPersonaName = text(s.customPersonaName, 120);
  state.settings.customPersonaDescription = text(s.customPersonaDescription, 50000);
  for (const key of ['presetOverrides', 'bookOverrides']) {
    state.settings[key] = Object.fromEntries(Object.entries(s[key] || {}).slice(0, 1000).map(([name, entries]) => [name,
      Object.fromEntries(Object.entries(entries || {}).slice(0, 5000).map(([entry, value]) => [entry,
        { ...(typeof value?.enabled === 'boolean' ? { enabled: value.enabled } : {}), ...(typeof value?.content === 'string' ? { content: text(value.content, 100000) } : {}) }]))]));
  }
  state.settings.readContext = s.readContext === true;
  for (const [key, min, max] of [['contextCount', 1, 200], ['words', 100, 20000], ['targetMessages', 1, 1000], ['maxTokens', 128, 200000]]) {
    state.settings[key] = clamp(s[key] ?? DEFAULT_SETTINGS[key], min, max, DEFAULT_SETTINGS[key]);
  }
  state.settings.stream = s.stream !== false;
  state.settings.launcherEnabled = s.launcherEnabled !== false;
  state.settings.models = strings(s.models, 10000);
  state.settings.modelsEndpoint = text(s.modelsEndpoint, 2000);
  if (Number.isFinite(s.launcher?.x) && Number.isFinite(s.launcher?.y)) state.settings.launcher = { x: s.launcher.x, y: s.launcher.y };
  state.draft = { prompt: text(raw.draft?.prompt), mode: normalizeMode(raw.draft?.mode) };
  state.editorDraft = raw.editorDraft && typeof raw.editorDraft === 'object' ? { storyId: text(raw.editorDraft.storyId, 100), chapterId: text(raw.editorDraft.chapterId, 100), title: text(raw.editorDraft.title, 120), content: text(raw.editorDraft.content), complete: raw.editorDraft.complete !== false } : null;
  const categoryIds = new Set();
  state.categories = list(raw.categories ?? [], 1000, '分类').map(c => {
    const key = safeId(c.id); assert(!categoryIds.has(key), '分类标识重复。'); categoryIds.add(key);
    return { id: key, name: text(c.name, 120).trim() || '未命名分类' };
  });
  const storyIds = new Set();
  state.themes = list(raw.themes ?? [], 100, '主题').map(theme => validateTheme(theme));
  state.stories = list(raw.stories ?? [], 10000, '番外').map(s => {
    const key = safeId(s.id); assert(!storyIds.has(key), '番外标识重复。'); storyIds.add(key);
    const chapters = list(s.chapters, 2000, '章节').map(c => ({ id: safeId(c.id), content: text(c.content), sourceContent: text(c.sourceContent), readingRegex: normalizeRegexRules(c.readingRegex), stickerSnapshot: normalizeStickers(c.stickerSnapshot), instruction: text(c.instruction), complete: c.complete !== false,
      mode: normalizeMode(c.mode || s.mode), themeId: text(c.themeId || s.themeId, 100), wordCount: Number(c.wordCount) || 0, targetWords: Number(c.targetWords) || 0,
      readingTheme: normalizeMode(c.mode || s.mode) === 'html' ? null : captureReadingTheme(c.readingTheme || (raw.themeCatalogVersion === 1 ? resolveTheme : resolveLegacyTheme)(state, normalizeMode(c.mode || s.mode), c.themeId || s.themeId), normalizeMode(c.mode || s.mode)),
      messageCount: Number(c.messageCount) || 0, targetMessages: Number(c.targetMessages) || 0, createdAt: Number(c.createdAt) || Date.now() }));
    assert(new Set(chapters.map(c => c.id)).size === chapters.length, '章节标识重复。');
    assert(s.mode === 'html' ? chapters.length <= 1 && chapters.every(c => c.mode === 'html') : chapters.every(c => c.mode !== 'html'), 'HTML 作品需独立保存，不支持续写或混合章节。');
    return { id: key, title: text(s.title, 120) || '未命名番外', prompt: text(s.prompt), mode: normalizeMode(s.mode),
      themeId: text(s.themeId, 100), snapshot: s.snapshot && typeof s.snapshot === 'object' ? clone(s.snapshot) : null,
      chapters, categoryIds: strings(s.categoryIds).filter(c => categoryIds.has(c)), tags: strings(s.tags, 100), saved: s.saved === true, syncConflict: s.syncConflict === true,
      continuationDraft: s.mode === 'html' ? '' : text(s.continuationDraft), continuationMode: s.mode === 'html' ? '' : (s.continuationMode || chapters.at(-1)?.mode || s.mode) === 'phone' ? 'phone' : 'prose',
      summaries: list(s.summaries ?? [], 200, '剧情总结').filter(x => Number.isInteger(x.through) && x.through > 0 && x.through <= chapters.length && x.through % 10 === 0).map(x => ({ through: x.through, content: text(x.content, 2000) })),
      createdAt: Number(s.createdAt) || Date.now(), updatedAt: Number(s.updatedAt) || Date.now() };
  });
  state.errors = list(raw.errors ?? [], 50, '报错记录').map(e => ({ time: Number(e.time) || Date.now(), stage: text(e.stage, 80), code: text(e.code, 80), message: text(e.message, 1500) }));
  if (raw.themeCatalogVersion !== 1) {
    // Freeze old chapters above before removing superseded development themes.
    state.themes = state.themes.filter(t => !THEME_ALIASES[t.id] && !RETIRED_THEME_IDS.includes(t.id));
    for (const [key, mode] of [['proseTheme', 'prose'], ['phoneTheme', 'phone']]) {
      const candidate = THEME_ALIASES[state.settings[key]] || state.settings[key];
      state.settings[key] = [...BUILTIN_THEMES, ...state.themes].some(t => t.id === candidate && t.mode === mode) ? candidate : DEFAULT_SETTINGS[key];
    }
    state.errors = state.errors.filter(e => !e.stage.startsWith('预览模拟'));
  }
  state.stories.forEach(recoverStoryTitle);
  return state;
}
export function backup(state) {
  // Whitelisted settings never contain credentials. Credentials live separately in scoped browser storage.
  const clean = normalizeState(state);
  return JSON.stringify({ ...clean, exportedAt: new Date().toISOString(), app: 'shunxi' }, null, 2);
}
