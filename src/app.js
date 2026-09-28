import { migrateStickerCatalogue } from './default-stickers.js';
import { htmlFilterRules } from './html-filters.js';
import { probeConnection } from './connection-test.js';
import { LibrarySync, sharedState, applyShared, equalSync } from './library-sync.js';
import { readerToken } from './regex-card.js';
import { syncCharacterBooks } from './character-sources.js';
import { ReaderAssets } from './reader-assets.js';
import { defaultRegexSelection, selectedRegexRules, transformProse } from './preset-regex.js';
import { generateTitle } from './story-title.js';
import { parsePhoneReport, serializePhone, safeStickerUrl, editablePhoneText, savePhoneEdit, phoneSourceBlock } from './phone-format.js';
import { PROSE_PREVIEW_TITLE, PROSE_PREVIEW_CONTENT } from './theme-preview.js';
import { VERSION, modeLabel, clone, id, newStory, appendChapter, invalidateSummaries, removeCategory, filterStories, backup, normalizeState } from './model.js';
import { LibraryStore } from './storage.js';
import { BUILTIN_THEMES, validateTheme, resolveTheme, captureReadingTheme, resolveChapterTheme, removeImportedTheme } from './themes.js';
import { renderReader } from './reader.js';
import { cleanHtml, htmlIssue, htmlDocument, HTML_SANDBOX } from './html-work.js';
import { PHONE_EXAMPLES } from './phone-examples.js';
import { phoneIcon } from './phone-assets.js';
import { generateChapter, ensureSummaries, contentLength } from './generation.js';
import { errorRecord } from './errors.js';
import { categoryFiles, makeZip, download } from './archive.js';

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false && !key.startsWith('aria-')) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') node.className = value;
    else if (key === 'value' || key === 'checked' || key === 'disabled') node[key] = value;
    else node.setAttribute(key, value === true && !key.startsWith('aria-') ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
const button = (label, action, attrs = {}) => el('button', { type: 'button', onClick: action, ...attrs }, label);
const label = (title, control, hint) => {
  control.setAttribute('aria-label', title);
  return el('label', { class: 'field' }, el('span', { class: 'field-label' }, title), control, hint ? el('small', {}, hint) : null);
};
function chevron(kind = 'down') {
  const node = el('span', { class: 'chevron', 'aria-hidden': true });
  node.innerHTML = phoneIcon(kind); return node;
}
function sourceRow(title, control) { return el('div', { class: 'source-row' }, el('span', { class: 'source-label' }, title), control); }
function choiceRow(input, text, trailing = null) {
  const activate = () => { input.focus({ preventScroll: true }); input.click(); };
  // Explicit forwarding works throughout a shadow root, including padded label space.
  // Cancel the label's default forwarding so a checkbox only toggles once.
  const choice = el('label', { class: 'source-option-choice', onPointerdown: e => {
    if (e.target !== input) e.preventDefault();
  }, onClick: e => {
    if (e.target === input) return;
    e.preventDefault(); activate();
  } }, input, el('span', {}, text));
  const row = el('div', { class: 'source-option', onClick: e => { if (e.target === row) activate(); } }, choice, trailing);
  return row;
}
function mobius() {
  const wrapper = el('span', { class: 'mark', 'aria-hidden': 'true' });
  // Authored vector icon; a single twisted ribbon, no external font/icon dependency.
  const ribbon = 'M13 5C3 5-2 16 3 25c5 9 15 7 25-2l9-8c5-4 10-3 12 1 2 4 0 8-4 8-3 0-6-2-9-5l-6 6c6 6 12 8 18 5 9-4 10-17 3-23-8-6-17-2-26 6l-9 8c-4 4-8 4-10 0-2-4 0-8 4-8 3 0 6 2 9 5l6-6C21 7 17 5 13 5Z';
  const track = 'M28 18C20 11 17 8 12 9C1 9 1 27 12 27C19 27 24 21 28 18C34 12 39 7 45 9C55 12 52 27 44 27C38 27 32 22 28 18Z';
  const clipId = `shunxi-ring-${id()}`;
  wrapper.innerHTML = `<svg viewBox="0 0 56 36" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="${clipId}"><path d="${ribbon}"/></clipPath></defs><path fill="currentColor" d="${ribbon}"/><g clip-path="url(#${clipId})"><path class="mobius-trail" pathLength="100" d="${track}"/><path class="mobius-spark" pathLength="100" d="${track}"/></g></svg>`;
  return wrapper;
}
export async function mount(host, { preview = false, stylesheet = null } = {}) {
  const previous = document.getElementById('shunxi-extension-root');
  if (previous) return;
  const store = new LibraryStore(host.scope);
  let state = await store.open();
  if (migrateStickerCatalogue(state.settings)) await store.save(state);
  state.themes = state.themes.map(validateTheme);
  let catalog = { characters: [], personas: [], books: [], presets: [] };
  let tab = 'generate', storyId = state.stories[0]?.id || null, chapterIndex = 0, continuationOpen = false;
  let category = 'all', tag = '', query = '', skinPreview = 'prose', task = null, editing = false, editText = '';
  if (state.editorDraft) {
    const saved = state.stories.find(story => story.id === state.editorDraft.storyId);
    const index = saved?.chapters.findIndex(ch => ch.id === state.editorDraft.chapterId) ?? -1;
    if (index >= 0) { storyId = saved.id; chapterIndex = index; editing = true; editText = state.editorDraft.content; }
  }
  const filterExpanded = { 分类: false, 标签: false }, filterLayouts = new Map();
  const filterObserver = new ResizeObserver(entries => {
    for (const entry of entries) filterLayouts.get(entry.target)?.(entry.contentRect.width);
  });
  let sync = null;
  let saveTimer, noticeTimer, unread = false, disposed = false, busyAction = false;
  let generationError = null, nativePanel = null, refreshRegexOptions = () => {}, catalogRequest = 0;
  const readingWarnings = new Set(), readerTokens = new WeakMap();
  const onReaderMessage = event => {
    const data = event.data;
    if (!data || data.type !== 'shunxi-reader-error' || typeof data.error !== 'string') return;
    const frame = [...shadow.querySelectorAll('iframe.prose-frame')].find(frame => frame.contentWindow === event.source);
    if (!frame || !readerTokens.get(frame) || readerTokens.get(frame) !== data.token) return;
    const warning = data.error.slice(0, 1000);
    if (!readingWarnings.has(warning)) { readingWarnings.add(warning); report(new Error(warning), '正文正则'); }
  };
  const readerAssets = new ReaderAssets(), panes = new Map();
  const root = el('div', { id: 'shunxi-extension-root', 'data-theme': state.settings.theme });
  const shadow = root.attachShadow({ mode: 'open' });
  if (stylesheet === null) {
    const cssResponse = await fetch(new URL('../style.css', import.meta.url));
    if (!cssResponse.ok) throw new Error('瞬息样式文件加载失败，请检查扩展目录是否完整。');
    stylesheet = await cssResponse.text();
  }
  window.addEventListener('message', onReaderMessage);
  shadow.append(el('style', {}, stylesheet));
  const launcher = button('', () => open(), { class: 'launcher', 'aria-label': '打开瞬息番外小剧场', title: '瞬息 · 拖动可移动，点击打开' });
  launcher.append(mobius(), el('span', { class: 'unread', hidden: true }));
  const dialog = el('dialog', { class: 'shell', 'aria-label': '瞬息番外小剧场' });
  const content = el('div', { class: 'workspace' });
  const status = el('div', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const nav = el('nav', { class: 'tabs', 'aria-label': '页面' });
  const themeButton = button(state.settings.theme === 'night' ? '☾' : '☼', toggleTheme, { class: 'icon-button', 'aria-label': '切换日夜模式' });
  const header = el('header', { class: 'topbar' }, el('div', { class: 'brand' }, mobius(), el('span', {}, '瞬息')), nav,
    el('div', { class: 'window-actions' }, themeButton, button('收起', () => dialog.close(), { class: 'window-close', 'aria-label': '收起瞬息，生成继续', title: '收起瞬息，生成继续' })));
  dialog.append(header);
  dialog.append(status, content);
  shadow.append(launcher, dialog); document.body.append(root);
  const openDropdowns = new Set();
  function setDropdownOpen(menu, open) {
    menu.dataset.open = String(open);
    menu.querySelector('.dropdown-trigger').setAttribute('aria-expanded', String(open));
    menu.querySelector('.dropdown-panel').hidden = !open;
    if (open) openDropdowns.add(menu); else openDropdowns.delete(menu);
  }
  // Close on an actual outside interaction, never during a label's focus transfer.
  // Hiding a native details/label while its click is being forwarded can hang Chromium.
  const closeOutsideDropdowns = e => {
    for (const menu of [...openDropdowns]) if (!e.composedPath().includes(menu)) setDropdownOpen(menu, false);
  };
  shadow.addEventListener('pointerdown', closeOutsideDropdowns);
  shadow.addEventListener('focusin', e => {
    // A real outside control can close menus; transient label/body blur cannot.
    if (e.composedPath()[0]?.matches?.('input,button,textarea,select,a[href],[tabindex]')) closeOutsideDropdowns(e);
  });
  function dropdown(title, initial, className = '') {
    const caption = el('span', { class: 'source-selection' }, initial);
    const panel = el('div', { class: 'dropdown-panel source-menu', hidden: true, role: 'group', 'aria-label': `${title}选项` });
    let menu;
    const trigger = button('', () => {
      const next = menu.dataset.open !== 'true';
      for (const other of [...openDropdowns]) if (other !== menu) setDropdownOpen(other, false);
      setDropdownOpen(menu, next);
    }, { class: 'dropdown-trigger', 'aria-label': title, 'aria-expanded': false });
    trigger.append(caption, chevron());
    menu = el('div', { class: `source-dropdown ${className}`, 'data-open': 'false', onKeydown: e => {
      if (e.key === 'Escape' && menu.dataset.open === 'true') { e.preventDefault(); e.stopPropagation(); setDropdownOpen(menu, false); trigger.focus(); }
      if (e.key === 'Tab') setTimeout(() => { if (!menu.contains(shadow.activeElement)) setDropdownOpen(menu, false); }, 0);
    } }, trigger, panel);
    return { menu, caption, panel };
  }
  function singleChoice(title, options, value, onChange) {
    const choice = dropdown(title, options.find(o => o.value === value)?.label || value);
    const groupName = id();
    choice.panel.setAttribute('role', 'radiogroup');
    choice.panel.append(...options.map(option => {
      const input = el('input', { type: 'radio', name: groupName, value: option.value, checked: option.value === value, 'aria-label': `${title}：${option.label}`, onChange: () => {
        choice.caption.textContent = option.label; choice.caption.title = option.label;
        onChange(option.value);
      } });
      return choiceRow(input, option.label);
    }));
    return choice.menu;
  }
  const dropdownField = (title, menu) => el('div', { class: 'field' }, el('span', { class: 'field-label' }, title), menu);
  dialog.addEventListener('close', () => { persist().catch(report); if (!launcher.hidden) launcher.focus(); });
  dialog.addEventListener('cancel', () => { if (task) notify('已收起，番外仍在生成。'); });
  const current = () => state.stories.find(s => s.id === storyId);
  function notify(message, error = false) {
    if (disposed) return;
    if (error) { report(new Error(message)); return; }
    clearTimeout(noticeTimer); status.textContent = message; status.dataset.error = error ? 'true' : 'false';
    if (!error) noticeTimer = setTimeout(() => { if (!task) status.textContent = ''; }, 8000);
  }
  function report(error, stage = task?.stage || '操作') {
    const entry = errorRecord(error, stage, host.getKey());
    state.errors.unshift(entry); state.errors = state.errors.slice(0, 50);
    if (task) generationError = entry;
    clearTimeout(noticeTimer); status.textContent = ''; status.dataset.error = 'false';
    store.save(state).catch(() => {});
    const list = shadow.querySelector('.error-list'); if (list) list.replaceChildren(...errorRows());
  }
  async function persist() { clearTimeout(saveTimer); store.checkpoint(state); await store.save(state); }
  function scheduleSave() {
    try { store.checkpoint(state); } catch (error) { report(error, '保存'); }
    clearTimeout(saveTimer); saveTimer = setTimeout(() => persist().catch(report), 250);
  }
  function setLauncherEnabled(value) { state.settings.launcherEnabled = value; launcher.hidden = !value; nativePanel?.sync(value); scheduleSave(); }
  async function action(fn) { if (busyAction) return; busyAction = true; try { await fn(); } catch (e) { report(e); } finally { busyAction = false; } }
  function open() { unread = false; launcher.querySelector('.unread').hidden = true; launcher.classList.remove('complete'); if (!dialog.open) dialog.showModal(); refreshCatalog(false); }
  function toggleTheme() { state.settings.theme = state.settings.theme === 'night' ? 'day' : 'night'; root.dataset.theme = state.settings.theme; themeButton.textContent = state.settings.theme === 'night' ? '☾' : '☼'; scheduleSave(); }
  function changeTab(value) { if (editing) { notify('请先保存或取消章节编辑。'); return; } tab = value; render(true); content.scrollTop = 0; }
  function renderNav() { nav.replaceChildren(...[['generate', '番外'], ['library', '分类'], ['themes', '美化'], ['settings', '设置']].map(([value, title]) => button(title, () => changeTab(value), { 'aria-current': value === tab ? 'page' : null, class: value === tab ? 'active' : '' }))); }
  function render(switching = false) {
    filterObserver.disconnect(); filterLayouts.clear();
    for (const menu of [...openDropdowns]) setDropdownOpen(menu, false);
    renderNav();
    const story = current();
    const signature = tab === 'generate' ? JSON.stringify([storyId, story?.updatedAt, story?.title, story?.chapters.length, chapterIndex, editing, Boolean(task), generationError, state.draft.mode]) : tab === 'themes' ? JSON.stringify([state.settings.proseTheme, state.settings.phoneTheme, state.themes, catalog.currentCharacter]) : '';
    let entry = panes.get(tab);
    if (!switching || !entry || entry.signature !== signature || !['generate','themes'].includes(tab)) {
      const page = tab === 'generate' ? generationPage() : tab === 'library' ? libraryPage() : tab === 'themes' ? themesPage() : settingsPage();
      if (entry) entry.page.replaceWith(page); else content.append(page);
      entry = { page, signature }; panes.set(tab, entry);
    } else if (tab === 'generate') {
      const mode = state.draft.mode;
      entry.page.querySelector('.composer .properties')?.replaceWith(summary(mode, state.settings.words, state.settings[mode === 'phone' ? 'phoneTheme' : 'proseTheme']));
    }
    for (const [name, item] of panes) item.page.hidden = name !== tab;
  }
  async function captureLegacyHtmlFilters(story) {
    if (story.snapshot?.htmlFiltersCaptured) return;
    // Old HTML did not save regex snapshots. An explicit edit/save captures only
    // its original named preset, never a different currently selected preset.
    const name = story.snapshot?.presetName;
    if (!name) return;
    const detail = await host.presetRegexDetail(name);
    const rules = htmlFilterRules(selectedRegexRules(detail, state.settings));
    for (const chapter of story.chapters) chapter.readingRegex = clone(rules);
    story.snapshot.htmlFiltersCaptured = true;
  }
  function makeReader(story, index = null, previewThemeId = null) {
    const mode = story.chapters[index]?.mode || story.mode;
    if (mode === 'html') {
      const chapter = story.chapters[index ?? 0], issue = htmlIssue(chapter?.content);
      if ((!chapter?.complete && cleanHtml(chapter?.content) === chapter?.content?.trim()) || issue) return el('div', { class: 'html-diagnostic' }, el('p', {}, issue || 'HTML 代码尚未标记完成，请编辑后保存。'), el('pre', { class: 'stream-output' }, chapter?.content || ''));
      return el('iframe', { class: 'reader-frame html-frame', title: `${story.title} HTML 作品`, sandbox: HTML_SANDBOX, referrerpolicy: 'no-referrer', allow: 'fullscreen', srcdoc: htmlDocument(chapter.content, chapter.readingRegex, story.snapshot, warnings => { for(const warning of warnings) if(!readingWarnings.has(warning)) { readingWarnings.add(warning); report(new Error(warning), 'HTML 过滤'); } }) });
    }
    const themeForChapter = ch => previewThemeId ? resolveTheme(state, ch.mode || story.mode, previewThemeId) : resolveChapterTheme(state, story, ch);
    const html = renderReader(story, themeForChapter(story.chapters[index ?? 0] || {}), index, themeForChapter, warnings => {
      for (const warning of warnings) if (!readingWarnings.has(warning)) { readingWarnings.add(warning); report(new Error(warning), '正文正则'); }
    });
    const token = readerToken(html);
    const frame = el('iframe', { class: mode === 'phone' ? 'reader-frame phone-frame' : 'reader-frame prose-frame', title: story.title + '阅读区', sandbox: token ? 'allow-scripts allow-same-origin' : '', referrerpolicy: 'no-referrer' });
    if (token) readerTokens.set(frame, token);
    // This outer document contains only sanitized markup and our nonce-protected
    // bridge. Keeping its origin avoids Chromium nested opaque-frame blanking.
    // Every rule script remains in a separate allow-scripts-only opaque card.
    if (host.prepareReaderHtml) frame.srcdoc = host.prepareReaderHtml(html);
    else readerAssets.prepare(html).then(doc => { if (!disposed) frame.srcdoc = doc; });
    return frame;
  }
  function summary(mode, words, themeId) {
    const s = state.settings;
    if (mode === 'html') return el('div', { class: 'properties html-properties' }, `最大回复 ${s.maxTokens} token`, el('span', {}, s.apiMode === 'main' ? '跟随主 API' : `独立 API${s.model ? ` · ${s.model}` : ''}`), el('span', {}, '作品自带样式'));
    return el('div', { class: 'properties' }, mode === 'phone' ? `目标 ${s.targetMessages} 条消息` : `目标 ${words} 字`, el('span', {}, s.apiMode === 'main' ? '跟随主 API' : `独立 API${s.model ? ` · ${s.model}` : ''}`), el('span', {}, `${mode === 'phone' ? '小手机' : '正文'} · ${resolveTheme(state, mode, themeId).name}`));
  }
  function chapterCount(story, chapter) {
    const mode = chapter.mode || story.mode;
    if (mode === 'html') return !htmlIssue(chapter.content) && (chapter.complete || cleanHtml(chapter.content)!==chapter.content.trim()) ? 'HTML · 代码已保存' : 'HTML · 代码未完整';
    let actual = '—'; try { actual = contentLength(chapter.content, mode, { character: story.snapshot?.character?.name, persona: story.snapshot?.persona?.name }); } catch { /* Keep malformed partial JSON editable. */ }
    const target = mode === 'phone' ? chapter.targetMessages : chapter.targetWords;
    const unit = mode === 'phone' ? '条' : '字';
    return Number.isFinite(Number(target)) && Number(target) > 0 ? `${actual}/${target}${unit}` : `${actual}${unit}`;
  }
  function generationPage() {
    const story = current(), page = el('section', { class: 'page generation-page' });
    const hasChapters = Boolean(story?.chapters.length), mode = state.draft.mode;
    const drafts = state.stories.filter(item => !item.saved && item.chapters.length && item.id !== story?.id);
    const resume = item => { storyId=item.id;chapterIndex=Math.max(0,item.chapters.length-1);continuationOpen=false;render(); };
    page.append(el('div', { class: 'page-heading' }, el('h1', {}, '番外'), drafts.length ? button('返回草稿', () => {
      if(drafts.length===1)return resume(drafts[0]);
      let pop;pop=popup('返回草稿',el('div',{class:'choice-list'},drafts.map(item=>button(item.title,()=>{pop.close();resume(item);}))));
    }, {class:'text-button',disabled:Boolean(task)||editing}) : null));
    const promptInput = el('textarea', { rows: 3, value: state.draft.prompt, 'aria-label': '番外设定', placeholder: '想看看另一个世界的你们？写下这篇番外的设定与要求。', disabled: Boolean(task) || editing, onInput: e => { state.draft.prompt = e.target.value; scheduleSave(); } });
    const modes = el('fieldset', { class: 'mode-choice', disabled: Boolean(task) || editing }, el('legend', {}, '生成模式'), ['prose', 'phone', 'html'].map(value => el('label', {}, el('input', { type: 'radio', name: 'story-mode', value, checked: mode === value, onChange: () => { state.draft.mode = value; scheduleSave(); render(); } }), modeLabel(value))));
    const themeId = state.settings[mode === 'phone' ? 'phoneTheme' : 'proseTheme'];
    page.append(el('div', { class: 'composer' }, promptInput, el('div', { class: 'composer-options' }, modes, summary(mode, state.settings.words, themeId), button(task ? '生成中…' : '生成番外', () => run(false), { class: 'primary', disabled: Boolean(task) || editing }))));
    page.append(el('div', { class: 'generation-feedback', 'aria-live': 'polite' }, generationError ? el('div', { class: 'generation-error', role: 'alert' }, el('strong', {}, `${generationError.stage} · ${generationError.code}`), el('p', {}, generationError.message), button('查看报错记录', () => changeTab('settings'), { class: 'text-button' })) : null));
    if (task) {
      page.append(el('div', { class: 'task-bar', role: 'status' }, '生成中 · 收起后继续', button('停止', stop, { class: 'outline' })), el('pre', { class: 'stream-output', 'data-stream': true }, task.stream ? task.visiblePartial || '正在准备资料…' : '正在等待完整回复…'));
    }
    if (hasChapters) {
      chapterIndex = Math.min(chapterIndex, story.chapters.length - 1);
      page.append(el('div', { class: 'chapter-bar' }, el('span', { class: 'chapter-count muted', 'aria-live': 'polite' }, chapterCount(story, story.chapters[chapterIndex])), story.mode === 'html' ? null : el('div', { class: 'chapter-buttons', 'aria-label': '章节' }, story.chapters.map((ch, i) => button(String(i + 1), () => { if (editing) return notify('请先保存编辑。'); chapterIndex = i; render(); }, { 'aria-pressed': chapterIndex === i, class: chapterIndex === i ? 'selected' : '' })))));
      if (editing) {
        const phoneChapter = (story.chapters[chapterIndex].mode || story.mode) === 'phone';
        const titleInput = el('input', { value: state.editorDraft?.title ?? story.title, maxlength: 120, onInput: e => { state.editorDraft.title = e.target.value; scheduleSave(); } });
        const editor = el('textarea', { rows: 14, value: editText, onInput: e => { editText = e.target.value; state.editorDraft.content = editText; scheduleSave(); } });
        const complete = el('input', { type: 'checkbox', checked: state.editorDraft?.complete ?? story.chapters[chapterIndex].complete, onChange: e => { state.editorDraft.complete = e.target.checked; scheduleSave(); } });
        page.append(phoneChapter ? null : label('标题', titleInput), label(story.mode === 'html' ? 'HTML 源代码' : (story.chapters[chapterIndex].mode || story.mode) === 'phone' ? '小手机消息' : '章节内容', editor, phoneChapter ? '每行一条，如 [char|23:48|你好]；特殊消息保留类型与对应字段。' : ''), el('label', { class: 'check-row' }, complete, story.mode === 'html' ? '页面代码完整' : '这一节已完成'), el('div', { class: 'actions' }, button('保存编辑', () => action(async () => {
          if (!editText.trim()) throw new Error('章节内容不能为空。');
          if (story.mode === 'html') { await captureLegacyHtmlFilters(story); if (complete.checked && htmlIssue(editText)) throw new Error(htmlIssue(editText)); story.chapters[chapterIndex].sourceContent=editText; }
          const phoneEdit = phoneChapter ? savePhoneEdit(story.chapters[chapterIndex], editText, state.settings.stickers, { character: story.snapshot?.character?.name, persona: story.snapshot?.persona?.name }) : null;
          if (!phoneChapter && story.mode !== 'html') story.chapters[chapterIndex].sourceContent = '';
          const size = complete.checked ? phoneEdit ? phoneEdit.messages.length : contentLength(editText, story.chapters[chapterIndex].mode || story.mode) : 0;
          if (!phoneChapter) story.title = titleInput.value.trim() || story.title; story.chapters[chapterIndex].content = story.mode==='html' ? cleanHtml(editText)||editText : editText; story.chapters[chapterIndex].complete = complete.checked;
          story.chapters[chapterIndex][(story.chapters[chapterIndex].mode || story.mode) === 'phone' ? 'messageCount' : 'wordCount'] = size;
          invalidateSummaries(story, chapterIndex);
          story.updatedAt = Date.now(); state.editorDraft = null; await persist(); editing = false; render(); notify(story.mode === 'html' ? 'HTML 编辑已保存。' : '编辑已保存，后续续写会使用修改后的内容。');
        }), { class: 'primary' }), button('取消', () => { editing = false; state.editorDraft = null; scheduleSave(); render(); })));
      } else {
        page.append(makeReader(story, chapterIndex), el('div', { class: 'actions reader-actions' },
          button('编辑', () => { editing = true; const chapter = story.chapters[chapterIndex]; editText = editablePhoneText(chapter); state.editorDraft = { storyId: story.id, chapterId: chapter.id, content: editText, title: story.title, complete: chapter.complete }; scheduleSave(); render(); }, { disabled: Boolean(task) }),
          story.mode !== 'html' && chapterIndex === story.chapters.length - 1 && !story.chapters[chapterIndex].complete ? button('继续补足', () => run(false, true), { disabled: Boolean(task) }) : null,
          button('复制', () => copyStory(story)), button('保存', () => organize(story), { disabled: Boolean(task) }),
          button('删除', () => deleteStory(story), { disabled: Boolean(task) })));
      }
      if (!editing && story.mode !== 'html') {
        let continuation;
        const toggle = button('续写本篇', () => {
          continuationOpen = !continuationOpen;
          toggle.setAttribute('aria-expanded', String(continuationOpen)); continuation.hidden = !continuationOpen;
        }, { class: 'section-toggle', 'aria-expanded': continuationOpen });
        toggle.append(chevron()); page.append(toggle);
        {
          const input = el('textarea', { rows: 3, value: story.continuationDraft || '', placeholder: '想让接下来发生什么？也可以填写台词、动作或文风要求。', disabled: Boolean(task), onInput: e => { story.continuationDraft = e.target.value; scheduleSave(); } });
          continuation = el('div', { class: 'continuation', hidden: !continuationOpen }, el('p', { class: 'muted' }, `接续第 ${story.chapters.length} 节，生成第 ${story.chapters.length + 1} 节`),
            label('续写要求（选填）', input, '留空则根据上文自然续写'),
            el('div', { class: 'submit-row' }, el('fieldset', { class: 'mode-choice', disabled: Boolean(task) }, el('legend', {}, '续写模式'), ['prose','phone'].map(value => el('label', {}, el('input', { type: 'radio', name: 'continuation-mode', value, checked: (story.continuationMode || story.mode) === value, onChange: () => { story.continuationMode = value; scheduleSave(); } }), value === 'prose' ? '正文' : '小手机'))), button(task ? '生成中…' : '开始续写', () => run(true), { class: 'primary', disabled: Boolean(task) })));
          page.append(continuation);
        }
      }
    } else if (!task && story) page.append(el('div', { class: 'empty-state' }, el('h2', {}, story.title || '番外'), el('p', {}, '这篇番外暂无章节。'), button('删除整篇', () => deleteStory(story))));
    else if (!task) page.append(el('div', { class: 'empty-state' }, el('h2', {}, '故事从这里开始'), el('p', {}, '写下另一种相遇。正文、小手机与 HTML，由你选择。')));
    return page;
  }
  async function run(continuing, toppingUp = false) {
    if (task || editing) return;
    const settings = clone(state.settings), previousStory = continuing || toppingUp ? current() : null;
    const unfinished = toppingUp ? previousStory?.chapters.at(-1) : null;
    if (toppingUp && !unfinished) return;
    if (unfinished) { settings.words = unfinished.targetWords || settings.words; settings.targetMessages = unfinished.targetMessages || settings.targetMessages; }
    const mode = unfinished ? unfinished.mode || previousStory.mode : continuing ? previousStory?.continuationMode || previousStory?.mode : state.draft.mode;
    const prompt = previousStory ? previousStory.prompt : state.draft.prompt;
    if (!prompt.trim()) return notify('请先填写番外内容。', true);
    if (continuing && (!previousStory?.chapters.length || previousStory.mode === 'html' || mode === 'html')) return;
    if (continuing && previousStory.chapters.at(-1).complete === false) return notify('请先编辑并标记最后一节完成，或删除未完成章节，再继续续写。', true);
    const controller = new AbortController();
    let readingTheme = null;
    generationError = null;
    const generation = { controller, partial: unfinished?.content || '', stream: settings.stream !== false, story: previousStory, instruction: unfinished?.instruction || (continuing ? previousStory.continuationDraft || '' : ''), conflict: false, appended: false, stage: '读取资料' };
    task = generation; launcher.classList.remove('complete'); launcher.classList.add('busy'); render();
    host.onMainConflict = () => { generation.conflict = true; controller.abort(); };
    try {
      if (!previousStory && host.characterSources) {
        const detail = await host.characterSources(); syncCharacterBooks(state.settings, detail);
        settings.books = [...state.settings.books]; settings.bookCharacter = detail.key;
      }
      await persist();
      readingTheme = mode === 'html' ? null : captureReadingTheme(resolveTheme(state, mode, settings[mode === 'phone' ? 'phoneTheme' : 'proseTheme']), mode);
      if (readingTheme && !preview) readerAssets.prepare(renderReader(sampleStory(mode), readingTheme, 0)).catch(() => {});
      const snapshot = previousStory?.snapshot || await host.snapshot(settings);
      generation.readingRegex = unfinished?.readingRegex || [];
      if ((mode === 'prose' || mode === 'html') && !unfinished) {
        try { generation.readingRegex = selectedRegexRules(await host.presetRegexDetail(settings.preset), settings); if (mode === 'html') snapshot.htmlFiltersCaptured = true; }
        catch (error) { report(error, '读取预设正则'); }
        if (mode === 'prose' && snapshot.characterKey) generation.readingRegex.push(...selectedRegexRules({ key:snapshot.characterKey, rules:snapshot.characterRegex || [] }, settings, 'regexCharacters')); 
      }
      if (mode === 'html') { generation.readingRegex = htmlFilterRules(generation.readingRegex); }
      const needsTitle = mode !== 'phone' && (previousStory?.title === '未命名番外' || !(previousStory?.chapters || []).some(ch => (ch.mode || previousStory.mode) === 'prose')); 
      if (unfinished?.readingTheme) settings.phoneTheme = unfinished.readingTheme.id;
      if (controller.signal.aborted) throw new DOMException('已停止', 'AbortError');
      const onPhase = message => { generation.stage = message.includes('总结') ? '剧情总结' : message.includes('补') ? '自动补写' : '生成'; status.textContent = message; };
      const referenceStory = unfinished ? { ...previousStory, chapters: previousStory.chapters.slice(0, -1) } : previousStory;
      const summary = referenceStory ? await ensureSummaries({ story: referenceStory, host, settings, signal: controller.signal, onPhase, onSave: persist }) : null;
      if (!generation.story) {
        generation.story = newStory({ title: mode === 'phone' ? '小手机 · ' + (snapshot.character?.name || '角色') + ' · ' + new Date().toLocaleString('zh-CN') : '未命名番外', prompt, mode, themeId: mode === 'html' ? '' : settings[mode === 'phone' ? 'phoneTheme' : 'proseTheme'], snapshot });
        state.stories.unshift(generation.story); storyId = generation.story.id;
      }
      await persist();
      render();
      generation.stage = '生成';
      const result = await generateChapter({ host, settings, snapshot, story: referenceStory, initialContent: unfinished?.content || '', prompt, mode, instruction: generation.instruction, summary, signal: controller.signal, onPhase, onSource: source => { const initial = unfinished?.sourceContent || unfinished?.content; generation.sourceContent = [initial ? mode === 'phone' ? phoneSourceBlock(initial) : initial : '', source].filter(Boolean).join('\n\n'); }, onWarnings: warnings => { for (const warning of warnings) if (mode === 'phone' && /^(本次有|本次回复)/.test(warning) && !generation.warnings?.has(warning)) { (generation.warnings ||= new Set()).add(warning); report(new Error(warning), '消息整理'); } }, onTitle: title => { if (needsTitle) { generation.story.title = title; scheduleSave(); } }, onChunk: content => {
        generation.partial = content;
        if (generation.stream) {
          generation.visiblePartial = mode === 'prose' ? transformProse(content, generation.readingRegex, snapshot).parts.map(p => p.html ? p.text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, '') : p.text).join('') : mode === 'phone' ? serializePhone(parsePhoneReport(content, { character: snapshot.character?.name, persona: snapshot.persona?.name }).messages) : cleanHtml(content, generation.readingRegex, snapshot);
          const output = shadow.querySelector('[data-stream]'); if (output) output.textContent = generation.visiblePartial;
        }
        status.textContent = mode === 'phone' ? `${generation.stage}中 · 正在接收手机消息 · 可以收起窗口` : `${generation.stage}中 · 已收到 ${content.length} 字符 · 可以收起窗口`;
      } });
      if (controller.signal.aborted) throw new DOMException('已停止', 'AbortError');
      if (unfinished) { Object.assign(unfinished, result, { sourceContent: generation.sourceContent || unfinished.sourceContent }); generation.story.updatedAt = Date.now(); }
      else appendChapter(generation.story, { ...result, readingRegex: generation.readingRegex, instruction: generation.instruction, mode, themeId: readingTheme?.id || '', readingTheme });
      generation.appended = true;
      if (result.title && needsTitle) generation.story.title = result.title;
      chapterIndex = generation.story.chapters.length - 1; await persist();
      if (needsTitle && !result.title) {
        onPhase('正在拟定标题…');
        try { generation.story.title = await generateTitle({ host, settings, snapshot, prompt, content: result.content, signal: controller.signal }); await persist(); } catch (error) { if (controller.signal.aborted) throw error; report(error, '标题生成'); }
      }
      await ensureSummaries({ story: generation.story, host, settings, signal: controller.signal, onPhase, onSave: persist });
      unread = !dialog.open; launcher.querySelector('.unread').hidden = !unread;
      launcher.classList.add('complete'); setTimeout(() => launcher.classList.remove('complete'), 3000);
      if (mode === 'html') { clearTimeout(noticeTimer); status.textContent = ''; }
      else notify(`本节已生成 · ${result.actual}${result.unit}${result.rounds ? ` · 自动补写 ${result.rounds} 轮` : ''}`);
    } catch (error) {
      if (!generation.appended && generation.story && (generation.partial.trim() || generation.sourceContent?.trim())) {
        try { if (unfinished) { unfinished.content = generation.partial || generation.sourceContent; unfinished.sourceContent = generation.sourceContent || unfinished.sourceContent; unfinished.complete = false; generation.story.updatedAt = Date.now(); } else appendChapter(generation.story, { content: generation.partial || generation.sourceContent, sourceContent: generation.sourceContent, readingRegex: generation.readingRegex, instruction: generation.instruction, complete: false, mode, targetWords: mode === 'prose' ? settings.words : 0, targetMessages: mode === 'phone' ? settings.targetMessages : 0, themeId: readingTheme?.id || '', readingTheme }); chapterIndex = generation.story.chapters.length - 1; await persist(); }
        catch (saveError) { report(saveError); }
      }
      if (!continuing && generation.story && generation.story.chapters.length === 0) {
        state.stories = state.stories.filter(s => s.id !== generation.story.id);
        storyId = null;
        await persist().catch(error => report(error, '保存'));
      }
      if (controller.signal.aborted) notify(mode === 'html' ? 'HTML 生成已停止。已收到的代码已保留，可编辑补全或重新生成。' : generation.appended ? '已停止总结，本节已保存；下次续写会重新总结。' : generation.conflict ? '正文开始生成，已停止跟随模式的番外；已收到的内容保留为草稿。' : '已停止。收到的内容已保留；请编辑并标记本节完成后再续写。');
      else report(error);
    } finally { task = null; host.onMainConflict = null; launcher.classList.remove('busy'); render(); }
  }
  function stop() { task?.controller.abort(); }
  function popup(title, body, footer = [], className = '') {
    const pop = el('dialog', { class: `popup ${className}`, 'aria-label': title });
    pop.append(el('div', { class: 'popup-heading' }, el('h2', {}, title), button('×', () => pop.close(), { class: 'icon-button', 'aria-label': '关闭' })), body, el('div', { class: 'actions' }, footer));
    shadow.append(pop); pop.addEventListener('close', () => { for (const menu of [...openDropdowns]) if (pop.contains(menu)) setDropdownOpen(menu, false); pop.remove(); }, { once: true }); pop.showModal(); return pop;
  }
  function ask(title, initial, submit) {
    const input = el('input', { value: initial, maxlength: 120 });
    const error = el('p', {class:'form-error',role:'alert',hidden:true});
    let pop; pop = popup(title, el('div',{},label(title,input),error), [button('取消', () => pop.close()), button('保存', () => action(async () => { try { await submit(input.value.trim()); pop.close(); render(); } catch (e) { error.hidden=false; error.textContent=e.message; report(e,title); } }), { class: 'primary' })]);
    input.focus();
  }
  function confirm(title, message, submit) {
    let pop; pop = popup(title, el('p', {}, message), [button('取消', () => pop.close()), button('确认', () => action(async () => { await submit(); pop.close(); render(); }), { class: 'primary' })]);
  }
  function organize(story) {
    const title = el('input', { value: story.title, maxlength: 120 });
    const tags = el('input', { value: story.tags.join('，'), placeholder: '用逗号分隔，如：现代，甜，已完结' });
    const categorySet = new Set(story.categoryIds);
    const names = () => state.categories.filter(c => categorySet.has(c.id)).map(c => c.name).join('、') || '未分类';
    const choices = dropdown('分类（多选）', names(), 'category-dropdown');
    const optionList = el('div', { class: 'category-options' });
    const empty = el('small', {}, '未选择分类时保存到未分类。');
    const search = el('input', { type:'search', placeholder:'搜索分类', 'aria-label':'搜索保存分类', onInput:() => paintCategories() });
    const paintCategories = () => {
      const query = search.value.trim().toLocaleLowerCase();
      const visible = state.categories.filter(c => c.name.toLocaleLowerCase().includes(query));
      optionList.replaceChildren(...visible.map(c => choiceRow(el('input', { type:'checkbox', checked:categorySet.has(c.id), 'aria-label':'归入' + c.name, onChange:e => {
        if (e.target.checked) categorySet.add(c.id); else categorySet.delete(c.id);
        choices.caption.textContent = names(); choices.caption.title = names();
      } }), c.name)));
      empty.hidden = visible.length > 0; empty.textContent = state.categories.length ? '没有匹配的分类。' : '未选择分类时保存到未分类。';
      choices.caption.textContent = names(); choices.caption.title = names();
    };
    choices.panel.append(search, optionList, el('div', {class:'category-create-row'}, empty, button('新建分类', () => addCategory(created => {
      categorySet.add(created.id); search.value = ''; paintCategories(); setDropdownOpen(choices.menu, true);
    }), {class:'text-button'})));
    paintCategories();
    let pop; pop = popup('保存番外', el('div', {}, label(story.chapters.every(ch => (ch.mode || story.mode) === 'phone') ? '收藏名称' : '标题', title), el('div', { class: 'field' }, el('span', { class: 'field-label' }, '分类'), choices.menu), label('标签', tags)), [button('取消', () => pop.close()), button('保存', () => action(async () => {
      story.title = title.value.trim() || story.title; story.tags = [...new Set(tags.value.split(/[,，\n]/).map(t => t.trim().slice(0, 60)).filter(Boolean))].slice(0, 100);
      story.categoryIds = [...categorySet]; story.saved = true; story.updatedAt = Date.now(); await persist(); pop.close(); render(); notify('已保存到收藏。');
    }), { class: 'primary' })]);
  }
  function copyStory(story) {
    if (story.mode === 'html') {
      const value = cleanHtml(story.chapters[0]?.content || '', story.chapters[0]?.readingRegex, story.snapshot);
      Promise.resolve().then(() => navigator.clipboard.writeText(value)).then(() => notify('HTML 源代码已复制。'), () => popup('手动复制 HTML', el('textarea', { rows: 12, value, readonly: true })));
      return;
    }
    let pop; const copy = async all => { const value = all ? story.chapters.map((c, i) => `第 ${i + 1} 节\n\n${c.content}`).join('\n\n') : story.chapters[chapterIndex].content;
      try { await navigator.clipboard.writeText(value); notify('已复制。'); pop.close(); } catch { popup('手动复制', el('textarea', { rows: 12, value, readonly: true })); } };
    pop = popup('复制番外', el('p', {}, '选择复制当前章节或整篇番外。'), [button('当前章节', () => copy(false)), button('整篇番外', () => copy(true), { class: 'primary' })]);
  }
  function deleteStory(story) {
    const whole = () => confirm(story.mode === 'html' ? '删除 HTML 作品' : '删除整篇番外', `删除「${story.title}」及全部章节？`, async () => {
      state.stories = state.stories.filter(s => s.id !== story.id);
      if (state.editorDraft?.storyId === story.id) state.editorDraft = null;
      storyId = null; chapterIndex = 0; await persist();
    });
    if (story.mode === 'html' || !story.chapters.length) return whole();
    const chapterId = story.chapters[chapterIndex]?.id;
    let pop; pop = popup('删除内容', el('p', {}, '删除后无法在插件内撤销。可以先到设置导出备份。'), [
      button('删除本节', () => {
        if (story.chapters.length <= 1) return;
        pop.close(); confirm('删除本节', `删除第 ${chapterIndex + 1} 节？后续章节不会自动重写。`, async () => {
          const target = state.stories.find(s => s.id === story.id), index = target?.chapters.findIndex(ch => ch.id === chapterId) ?? -1;
          // Recheck after confirmation; a stale dialog must never remove the last chapter.
          if (!target || target.chapters.length <= 1 || index < 0) return;
          invalidateSummaries(target, index); target.chapters.splice(index, 1); target.updatedAt = Date.now();
          chapterIndex = Math.max(0, index - 1); await persist();
        });
      }, { disabled: story.chapters.length <= 1 }),
      button('删除整篇', () => { pop.close(); whole(); })
    ]);
  }
  function categoryItems() { return [...(state.categories.length ? [{ id: 'all', name: '全部' }, ...state.categories] : []), { id: 'uncategorized', name: '未分类' }]; }
  function chooseCategory(value) { category = value; render(); }
  function addCategory(onCreated) { ask('新建分类', '', async name => { if (!name) throw new Error('分类名称不能为空。'); if (state.categories.some(c => c.name === name)) throw new Error('已有同名分类。'); const created = {id:id(),name}; state.categories.push(created); await persist(); if (typeof onCreated === 'function') onCreated(created); }); }
  function manageCategories() {
    let pop; pop = popup('管理分类', el('div', { class: 'choice-list' }, state.categories.map(c => el('div', { class: 'manage-row' }, el('span', {}, c.name), button('改名', () => { pop.close(); ask('重命名分类', c.name, async name => { if (!name || state.categories.some(other => other.id !== c.id && other.name === name)) throw new Error('名称不能为空或重复。'); c.name = name; await persist(); }); }), button('删除', () => { pop.close(); confirm('删除分类', '只解除归类，保留分类中的番外。', async () => { removeCategory(state, c.id); if (category === c.id) category = 'all'; await persist(); }); })))));
  }
  function storyRows() {
    const stories = filterStories(state, { category, tag, query });
    if (!stories.length) return [el('div', { class: 'empty-state' }, el('h2', {}, '这里还没有故事'), el('p', {}, '换个分类或标签看看，或生成新的番外。'))];
    return stories.map(story => el('article', { class: 'story-row' }, button(story.title, () => { if (task) return notify('请先完成当前生成。'); storyId = story.id; chapterIndex = Math.max(0, story.chapters.length - 1); tab = 'generate'; continuationOpen = false; render(); }, { class: 'story-title' }),
      el('span', { class: 'story-meta' }, `${story.mode === 'html' ? '独立作品' : `${story.chapters.length} 节`} · ${new Set(story.chapters.map(ch => ch.mode || story.mode)).size > 1 ? '混合' : modeLabel(story.chapters[0]?.mode || story.mode)}`),
      el('span', { class: 'story-categories' }, story.categoryIds.map(key => state.categories.find(c => c.id === key)?.name).filter(Boolean).join(' / ') || '未分类'),
      el('span', { class: 'story-tags' }, story.tags.slice(0, 3).join(' · ')), button('⋯', () => organize(story), { 'aria-label': `整理${story.title}`, class: 'icon-button' })));
  }
  function libraryPage() {
    const categories = categoryItems(); if (!categories.some(c => c.id === category)) category = state.categories.length ? 'all' : 'uncategorized';
    const tags = [...new Set(state.stories.filter(s => s.saved).flatMap(s => s.tags))];
    const list = el('div', { class: 'story-list' }, storyRows());
    const search = el('input', { type: 'search', placeholder: '搜索番外', value: query, 'aria-label': '搜索番外', onInput: e => { query = e.target.value; list.replaceChildren(...storyRows()); } });
    const filterRow = (title, controls, className) => {
      const strip = el('div', { id: `shunxi-filter-${className}`, class: 'filter-strip', role: 'group', 'aria-label': `${title}筛选` }, controls);
      const toggle = button(chevron('doubleDown'), () => { filterExpanded[title] = !filterExpanded[title]; layout(); }, { class: 'filter-toggle', 'aria-controls': strip.id, 'aria-expanded': filterExpanded[title], 'aria-label': `${filterExpanded[title] ? '收起' : '展开'}${title}`, hidden: true });
      let lastWidth = -1;
      const layout = width => {
        if (!strip.isConnected || width !== undefined && width === lastWidth) return;
        lastWidth = strip.getBoundingClientRect().width;
        controls.forEach(control => { control.hidden = false; });
        const firstTop = controls[0]?.offsetTop;
        const overflow = controls.filter(control => control.offsetTop > firstTop + 1);
        toggle.hidden = !overflow.length;
        toggle.setAttribute('aria-expanded', String(filterExpanded[title]));
        toggle.setAttribute('aria-label', `${filterExpanded[title] ? '收起' : '展开'}${title}`);
        if (!filterExpanded[title]) overflow.forEach(control => { control.hidden = true; });
      };
      filterLayouts.set(strip, layout); filterObserver.observe(strip);
      requestAnimationFrame(() => layout());
      return el('div', { class: `filter-row ${className}` }, el('span', { class: 'filter-label' }, title), strip, toggle);
    };
    return el('section', { class: 'page library-main' }, el('div', { class: 'page-heading' }, el('h1', {}, '分类收藏')), search,
      el('div', { class: 'library-tools' }, button('＋ 新建分类', addCategory), button('管理分类', manageCategories)),
      filterRow('分类', categories.map(c => button(c.name, () => chooseCategory(c.id), { 'aria-pressed': category === c.id, class: category === c.id ? 'active' : '' })), 'category-filter'),
      filterRow('标签', [{ value: '', name: '全部' }, ...tags.map(t => ({ value: t, name: t }))].map(t => button(t.name, () => { tag = t.value; render(); }, { 'aria-pressed': tag === t.value, class: tag === t.value ? 'active' : '' })), 'tag-filter'), list);
  }
  function sampleStory(mode) {
    return { title: mode === 'phone' ? '晚安之前' : PROSE_PREVIEW_TITLE, mode, snapshot: { character: { name: preview ? '林舟' : catalog.currentCharacter || '角色' } }, chapters: [{ complete: true, content: mode === 'phone' ? serializePhone([...PHONE_EXAMPLES, { type: 'retract', sender: 'char', time: '23:54', text: '其实，只是想多听一会儿你的声音。' }]) : PROSE_PREVIEW_CONTENT }] };
  }
  function themesPage() {
    const themes = [...BUILTIN_THEMES, ...state.themes];
    const deleteButton = button('删除', () => {
      const mode = skinPreview, theme = resolveTheme(state, mode, state.settings[mode === 'phone' ? 'phoneTheme' : 'proseTheme']);
      if (!state.themes.some(t => t.id === theme.id)) return;
      confirm('删除主题', `确定删除${mode === 'phone' ? '小手机' : '正文'}主题「${theme.name}」？确认后会从主题库移除，并切换为${mode === 'prose' ? '邮票素笺' : '简白'}。已保存番外保留当时的样式。`, async () => {
        removeImportedTheme(state, theme.id); await persist();
      });
    }, { class: 'outline' });
    const refreshDelete = () => {
      const theme = resolveTheme(state, skinPreview, state.settings[skinPreview === 'phone' ? 'phoneTheme' : 'proseTheme']);
      deleteButton.disabled = !state.themes.some(t => t.id === theme.id);
      deleteButton.title = deleteButton.disabled ? '内置默认风格不能删除' : `删除${skinPreview === 'phone' ? '小手机' : '正文'}主题：${theme.name}`;
    };
    const panels = ['prose', 'phone'].map(mode => {
      const key = mode === 'prose' ? 'proseTheme' : 'phoneTheme', title = mode === 'prose' ? '正文风格' : '小手机风格';
      const activate = () => {
        skinPreview = mode;
        for (const column of shadow.querySelectorAll('.skin-column')) column.classList.toggle('current-preview', column.dataset.mode === mode);
        refreshDelete();
      };
      const previewPanel = el('div', { class: 'skin-preview' });
      const refreshPreview = () => previewPanel.replaceChildren(el('p', { class: 'muted' }, `正在预览：${title} · ${resolveTheme(state, mode, state.settings[key]).name}`), makeReader(sampleStory(mode), 0, state.settings[key]));
      const choice = singleChoice(title, themes.filter(t => t.mode === mode).map(t => ({ value: t.id, label: t.name })), state.settings[key], value => { selectReadingTheme(mode, value); activate(); scheduleSave(); refreshPreview(); });
      choice.addEventListener('focusin', activate); refreshPreview();
      return el('div', { class: `skin-column ${skinPreview === mode ? 'current-preview' : ''}`, 'data-mode': mode, onPointerdown: activate }, dropdownField(title, choice), previewPanel);
    });
    const imported = el('input', { type: 'file', accept: '.json,application/json', hidden: true, onChange: e => action(async () => {
      const file = e.target.files?.[0]; if (!file) return; if (file.size > 1000000) throw new Error('主题文件过大，请使用小于 1 MB 的 JSON。');
      const raw = JSON.parse(await file.text()), incoming = Array.isArray(raw.themes) ? raw.themes : [raw];
      if (!incoming.length || incoming.length > 100) throw new Error('主题包数量不正确。');
      const valid = incoming.map(validateTheme);
      const merged = new Map(state.themes.map(t => [t.id, t])); for (const t of valid) merged.set(t.id, t);
      if (merged.size > 100) throw new Error('自定义主题数量超过 100。');
      state.themes = [...merged.values()];
      for (const theme of valid) { selectReadingTheme(theme.mode, theme.id); skinPreview = theme.mode; }
      await persist(); render(); notify(`阅读主题已导入并选中：${valid.map(t => `${t.mode === 'phone' ? '小手机' : '正文'} · ${t.name}`).join('；')}。`);
    }) });
    refreshDelete();
    return el('section', { class: 'page' }, el('div', { class: 'page-heading theme-heading' }, el('h1', {}, '阅读美化'),
      el('div', { class: 'theme-actions' }, button('导入', () => imported.click(), { class: 'outline' }), button('导出', () => download(JSON.stringify({ format: 'shunxi-reading-themes', version: 1, themes: ['prose','phone'].map(mode => resolveTheme(state, mode, state.settings[mode === 'phone' ? 'phoneTheme' : 'proseTheme'])) }, null, 2), '瞬息-阅读主题.json', 'application/json'), { class: 'outline' }), deleteButton)),
      el('p', { class: 'muted' }, '选择新章节的阅读风格，已生成内容保留原样。'), el('div', { class: 'skins-grid' }, panels), imported);
  }
  function selectReadingTheme(mode, themeId) {
    state.settings[mode === 'phone' ? 'phoneTheme' : 'proseTheme'] = themeId;
  }
  async function refreshCatalog(showNotice = true) {
    const request = ++catalogRequest;
    try {
      const next = await host.catalog();
      if (disposed || request !== catalogRequest) return;
      catalog = next;
      if (catalog.characterSources) { syncCharacterBooks(state.settings, catalog.characterSources); scheduleSave(); }
      if (tab === 'settings') render();
      if (showNotice) notify('酒馆资料列表已刷新。');
    } catch (e) { if (!disposed && request === catalogRequest && e.code !== 'CHARACTER_CHANGED') report(e, '读取酒馆资料'); }
  }
  function errorRows() {
    return state.errors.length ? state.errors.map(e => el('article', { class: 'error-row' }, el('small', {}, `${new Date(e.time).toLocaleString()} · ${e.stage}`), el('strong', {}, e.code), el('p', {}, e.message))) : [el('p', { class: 'muted' }, '暂无报错')];
  }
  function entryRows(kind, name, entries) {
    const mapKey = kind === 'preset' ? 'presetOverrides' : 'bookOverrides';
    const set = (id, patch) => {
      const maps = state.settings[mapKey];
      maps[name] = { ...(maps[name] || {}), [id]: { ...(maps[name]?.[id] || {}), ...patch } }; scheduleSave();
    };
    return entries.map(entry => {
      const change = state.settings[mapKey]?.[name]?.[entry.id] || {};
      const checkbox = el('input', { type: 'checkbox', checked: change.enabled ?? entry.enabled, 'aria-label': `启用${entry.name}`, onClick: e => e.stopPropagation(), onChange: e => set(entry.id, { enabled: e.target.checked }) });
      return el('details', { class: 'source-entry' }, el('summary', {}, checkbox, el('span', {}, entry.name)),
        entry.marker ? el('p', { class: 'muted' }, '酒馆资料占位项') : label(`${entry.name}内容`, el('textarea', { rows: 4, value: change.content ?? entry.content, onInput: e => set(entry.id, { content: e.target.value }) })));
    });
  }
  function sourceArrow(kind, name, title) {
    const control = button('', () => action(async () => {
      const menu = control.closest('.source-dropdown'); if (menu) { setDropdownOpen(menu, false); menu.querySelector('.dropdown-trigger').focus(); }
      const body = el('div', { class: 'source-detail' }, el('p', { class: 'muted' }, '正在读取条目…'));
      const pop = popup(kind === 'preset' ? '预设条目' : '世界书条目', body, [], 'source-popup');
      try {
        const details = [kind === 'preset' ? await host.presetDetail(name) : await host.bookDetail(name)];
        if (!pop.isConnected) return;
        const choices = [];
        const syncAll = () => { selectAll.textContent = choices.length && choices.every(choice => choice.input.checked) ? '全选取消' : '全选'; };
        const selectAll = button('全选', () => {
          const enabled = !choices.every(choice => choice.input.checked);
          const maps = state.settings[kind === 'preset' ? 'presetOverrides' : 'bookOverrides'];
          choices.forEach(choice => {
            choice.input.checked = enabled;
            maps[choice.name] ||= {};
            maps[choice.name][choice.id] = { ...maps[choice.name][choice.id], enabled };
          });
          syncAll(); scheduleSave();
        }, { class: 'text-button' });
        const sections = details.map(detail => {
          const entries = kind === 'preset' ? detail.prompts : detail.entries;
          const title = kind === 'book' ? catalog.books.find(b => b.value === detail.name)?.label || detail.name : detail.name;
          const rows = entryRows(kind, detail.name, entries);
          rows.forEach((row, i) => choices.push({ name: detail.name, id: entries[i].id, input: row.querySelector('input[type=checkbox]') }));
          return el('section', {}, el('h3', {}, title), entries.length ? rows : el('p', { class: 'muted' }, '暂无条目'));
        });
        selectAll.disabled = choices.length === 0;
        choices.forEach(choice => choice.input.addEventListener('change', syncAll)); syncAll();
        body.replaceChildren(el('div', { class: 'source-detail-toolbar' }, el('p', { class: 'muted' }, '勾选和文本修改只用于番外，自动保存。'), selectAll), ...sections);
      } catch (error) { body.replaceChildren(el('p', {}, '条目读取失败，详情已记录在报错记录。')); report(error, kind === 'preset' ? '读取预设' : '读取世界书'); }
    }), { class: 'source-arrow icon-button', 'aria-label': `查看${kind === 'preset' ? '预设' : '世界书'}：${title}` });
    control.innerHTML = phoneIcon('arrow'); return control;
  }
  function sourceSelector(kind) {
    const s = state.settings, isBook = kind === 'book', title = isBook ? '世界书' : '预设';
    const options = isBook ? catalog.books : [{ value: '', label: '使用当前已保存预设' }, { value: '__none__', label: '不采用预设' }, ...catalog.presets];
    const selectedNames = () => isBook ? s.books.map(v => catalog.books.find(b => b.value === v)?.label || v).join('、') || '选择世界书（可多选）' : options.find(o => o.value === s.preset)?.label || s.preset;
    const { menu, caption, panel } = dropdown(`${title}（${isBook ? '多选' : '单选'}）`, selectedNames());
    panel.setAttribute('aria-label', `${title}选项`);
    panel.append(...(options.length ? options.map(option => {
      const input = el('input', { type: isBook ? 'checkbox' : 'radio', name: isBook ? null : 'shunxi-preset-choice', value: option.value, checked: isBook ? s.books.includes(option.value) : s.preset === option.value, 'aria-label': `${isBook ? '使用世界书' : '使用预设'}${option.label}`, onChange: e => {
        if (isBook) s.books = e.target.checked ? [...new Set([...s.books, option.value])] : s.books.filter(v => v !== option.value);
        else { s.preset = option.value; refreshRegexOptions(); }
        caption.textContent = selectedNames(); caption.title = caption.textContent; scheduleSave();
      } });
      return choiceRow(input, option.label, option.value === '__none__' ? null : sourceArrow(kind, option.value, option.label));
    }) : [el('p', { class: 'muted' }, `当前酒馆没有${title}。`)]));
    return sourceRow(title, menu);
  }
  function regexSelector(kind = 'preset') {
    const character = kind === 'character', title = character ? '角色正则' : '预设正则', field = character ? 'regexCharacters' : 'regexPresets';
    const { menu, caption, panel } = dropdown(title + '（多选）', '正在读取…');
    const row = sourceRow(title, menu); row.classList.add('regex-source-row');
    let request = 0;
    const paint = detail => {
      const settings = state.settings, key = detail.key || detail.name;
      const config = () => Object.hasOwn(settings[field], key) ? settings[field][key] : { selected: defaultRegexSelection(detail.rules), edits: {} };
      const ensure = () => { if (!Object.hasOwn(settings[field], key)) settings[field] = { ...settings[field], [key]:config() }; return settings[field][key]; };
      const name = rule => config().edits[rule.id]?.scriptName || rule.scriptName;
      const updateCaption = () => { caption.textContent = detail.rules.filter(rule => config().selected.includes(rule.id)).map(name).join('、') || (detail.rules.length ? '选择正则（可多选）' : `此${character ? '角色' : '预设'}暂无正则`); caption.title = caption.textContent; };
      updateCaption();
      panel.replaceChildren(...(detail.rules.length ? detail.rules.map(rule => {
        const check = el('input', { type:'checkbox', checked:config().selected.includes(rule.id), 'aria-label':'使用正则' + name(rule), onChange:e => {
          const value = ensure(); value.selected = e.target.checked ? [...new Set([...value.selected, rule.id])] : value.selected.filter(id => id !== rule.id); updateCaption(); scheduleSave();
        } });
        const arrow = button('', () => {
          setDropdownOpen(menu, false);
          const value = ensure(), draft = { ...rule, ...value.edits[rule.id] };
          const field = (title, key, rows) => label(title, el(rows ? 'textarea' : 'input', { value: key === 'trimStrings' ? draft[key].join('\n') : draft[key], rows, onInput:e => {
            draft[key] = key === 'trimStrings' ? e.target.value.split('\n').filter(Boolean) : e.target.value; value.edits = { ...value.edits, [rule.id]:{ ...draft } }; scheduleSave();
          } }));
          const scopes = rule.placement.map(n => ({ 1:'用户输入', 2:'AI 回复', 3:'快捷命令', 5:'世界书', 6:'思考内容' }[n] || String(n))).join('、');
          const pop = popup(title + '详情', el('div', {}, field('正则名称','scriptName'), field('表达式','findRegex',4), field('替换式','replaceString',7), field('裁剪内容（每行一项）','trimStrings',3),
            el('p',{class:'muted'},field === 'regexCharacters' ? '仅用于瞬息正文显示，编辑原文和酒馆源规则保持不变；修改自动保存。' : '用于正文显示；HTML 仅使用替换为空的过滤规则。编辑原文和酒馆源规则保持不变；修改自动保存。'),
            el('p',{class:'muted'},`来源原设置：${rule.disabled ? '已禁用' : '已启用'}；${scopes || '未指定范围'}；${rule.markdownOnly ? '仅显示' : rule.promptOnly ? '仅提示词' : '通用'}；深度 ${rule.minDepth ?? '不限'}—${rule.maxDepth ?? '不限'}；编辑时运行：${rule.runOnEdit ? '是' : '否'}；表达式宏：${['不替换','替换','转义后替换'][rule.substituteRegex]}。`)));
          pop.addEventListener('close', () => paint(detail), { once:true });
        }, { class:'source-arrow icon-button', 'aria-label':'查看正则：' + name(rule) });
        arrow.innerHTML = phoneIcon('arrow'); return choiceRow(check, name(rule), arrow);
      }) : [el('p', {class:'muted'}, `此${character ? '角色' : '预设'}暂无正则。`)]));
    };
    const refresh = async () => {
      const currentRequest = ++request, preset = state.settings.preset;
      caption.textContent = '正在读取…'; panel.replaceChildren();
      try {
        const detail = character ? catalog.characterSources || {key:'',name:'',rules:[]} : await host.presetRegexDetail(preset);
        if (currentRequest === request && row.isConnected) paint(detail);
      } catch(error) {
        if (currentRequest !== request || !row.isConnected) return;
        caption.textContent = '读取失败'; panel.append(el('p', {class:'muted'}, '读取失败，请刷新酒馆资料。')); report(error, '读取' + title);
      }
    };
    if (!character) refreshRegexOptions = refresh;
    queueMicrotask(refresh);
    return row;
  }
  function editPersona() {
    action(async () => {
      const s = state.settings;
      let following = s.personaMode !== 'custom';
      const initial = following ? await host.personaDetail() : { name: s.customPersonaName, description: s.customPersonaDescription };
      const name = el('input', { value: initial.name, maxlength: 120, onInput: () => { following = false; } });
      const description = el('textarea', { value: initial.description, rows: 8, maxlength: 50000, onInput: () => { following = false; } });
      let pop;
      pop = popup('当前面具', el('div', {}, label('面具名字', name), label('面具内容', description), el('p', { class: 'muted' }, '保存后用于新番外，已有番外保留原有人设。')),
        [button('读取当前面具', () => action(async () => {
          const persona = await host.personaDetail(); following = true; name.value = persona.name; description.value = persona.description;
          s.personaMode = 'current'; s.customPersonaName = ''; s.customPersonaDescription = ''; catalog.currentPersona = persona.name;
          await persist(); render(); notify('已恢复跟随酒馆当前面具。');
        }), { class: 'outline' }), button('保存面具', () => action(async () => {
          if (!name.value.trim()) throw new Error('请填写面具名字。');
          s.personaMode = following ? 'current' : 'custom'; s.customPersonaName = following ? '' : name.value.trim(); s.customPersonaDescription = following ? '' : description.value;
          await persist(); pop.close(); render(); notify('面具已保存，后续新番外使用此人设。');
        }), { class: 'primary' })]);
    });
  }
  function stickerLibrary() {
    const grid = el('div', { class: 'sticker-grid', 'aria-label': '表情包缩略图' });
    const thumbnail = (item, className = 'sticker-thumbnail') => {
      const fallback = el('span', { class: 'sticker-image-fallback' }, (item.name || '未命名').slice(0, 2));
      const url = safeStickerUrl(item.url);
      const image = url ? el('img', { src: host.previewImage?.(url) || url, alt: item.name || '表情包', loading: 'lazy', referrerpolicy: 'no-referrer', onLoad: () => { fallback.hidden = true; }, onError: e => { e.target.hidden = true; fallback.hidden = false; } }) : null;
      return el('span', { class: className }, fallback, image);
    };
    const editSticker = index => {
      const old = state.settings.stickerDraft;
      const draft = old && old.index === index ? old : { index, item: { ...(index === null ? { name: '', url: '', description: '' } : state.settings.stickers[index]) } };
      state.settings.stickerDraft = draft; scheduleSave();
      const field = (title, key, max, placeholder) => label(title, el(key === 'description' ? 'textarea' : 'input', { value: draft.item[key], maxlength: max, rows: key === 'description' ? 3 : null, placeholder, onInput: e => { draft.item[key] = e.target.value; scheduleSave(); } }));
      const feedback = el('p', { role: 'alert', class: 'sticker-editor-error' });
      const invalid = message => { feedback.textContent = message; throw new Error(message); };
      let pop;
      pop = popup(index === null ? '添加表情包' : '修改表情包', el('div', {}, field('表情包名字', 'name', 120, '猫猫点头'), field('图片地址', 'url', 4000, 'https://…'), field('描述', 'description', 1000, '开心地赞同、答应对方'), feedback),
        [button('取消', () => { pop.close(); draw(); }), button('保存', () => action(async () => {
          const item = { name: draft.item.name.trim(), url: safeStickerUrl(draft.item.url.trim()), description: draft.item.description.trim() };
          feedback.textContent = '';
          if (!item.name) return invalid('请填写表情包名字。');
          if (!item.url) return invalid('请填写 HTTP(S) 图片直链。');
          if (state.settings.stickers.some((row, i) => i !== index && row.name.trim() === item.name)) return invalid('已有同名表情包，请换一个名字。');
          if (index === null) { if (state.settings.stickers.length >= 500) return invalid('最多保存 500 个表情包。'); state.settings.stickers.push(item); }
          else state.settings.stickers[index] = item;
          state.settings.stickerDraft = null; await persist(); pop.close(); draw();
        }), { class: 'primary' })]);
      pop.addEventListener('close', draw, { once: true });
    };
    const inspectSticker = (index, anchor) => {
      const item = state.settings.stickers[index];
      const menu = el('div', { class: 'sticker-menu', popover: 'auto', role: 'group', 'aria-label': '表情包操作' });
      const close = () => { menu.hidePopover(); menu.remove(); };
      menu.append(button('编辑', () => { close(); editSticker(index); }), button('删除', () => {
        close(); confirm('删除表情包', `确认删除“${item.name}”吗？`, async () => {
          state.settings.stickers.splice(index, 1);
          const draft = state.settings.stickerDraft;
          if (draft?.index === index) state.settings.stickerDraft = null;
          else if (draft?.index > index) draft.index--;
          await persist();
        });
      }));
      dialog.append(menu); menu.showPopover();
      const rect = anchor.getBoundingClientRect(), box = menu.getBoundingClientRect();
      menu.style.left = Math.max(8, Math.min(rect.left + rect.width / 2 - box.width / 2, innerWidth - box.width - 8)) + 'px';
      menu.style.top = Math.max(8, rect.bottom + box.height + 8 < innerHeight ? rect.bottom + 6 : rect.top - box.height - 6) + 'px';
      menu.addEventListener('toggle', e => { if (e.newState === 'closed') menu.remove(); });
      menu.querySelector('button').focus({ preventScroll: true });
    };
    const add = button('添加表情包', () => editSticker(null), { class: 'text-button' });
    const draw = () => {
      grid.replaceChildren(...state.settings.stickers.map((item, index) => {
        const tile = button('', e => inspectSticker(index, e.currentTarget), { class: 'sticker-tile', title: item.name || '未命名表情包', 'aria-label': '查看表情包：' + (item.name || '未命名') });
        tile.append(thumbnail(item)); return tile;
      }));
    };
    draw();
    return el('section', { class: 'settings-group sticker-library' }, el('div', { class: 'page-heading' }, el('h2', {}, '小手机表情包'), add), grid);
  }
  function syncCopies() {
    let pop;
    const copies=state.stories.filter(story=>story.syncConflict);
    pop=popup('同步保留的副本',el('div',{},copies.length?copies.map(story=>el('div',{class:'actions'},el('span',{},story.title),button('查看',()=>{
      if(!story.chapters.length){popup('保留的番外设定',label('番外设定',el('textarea',{rows:10,value:story.prompt,readonly:true})));return;}
      pop.close();storyId=story.id;chapterIndex=0;tab='generate';render();
    }))):el('p',{},'目前没有需要查看的副本。')));
  }
  function syncPanel() {
    const recovery=()=>action(async()=>{
      const saved=await store.syncRecovery();
      if(!saved){notify('还没有同步前备份。');return;}
      download(backup(saved),`瞬息-同步前备份-${Date.now()}.json`,'application/json');
    });
    return el('div',{},
      el('p',{class:'muted'},preview?'预览中的上传／下载使用本页临时模拟资料，不连接酒馆服务器。':'同一酒馆服务器、同一账号可手动合并作品、分类、美化、表情和设置；API 密钥仍在每台设备单独填写。'),
      el('p',{class:'muted'},'请逐台同步，避免同时上传。同篇冲突保留副本；删除不随同步传播，另一设备保留的内容可能重新出现。'),
      el('p',{'data-sync-status':true,role:'status'},sync?.status.text||'当前环境暂不能连接同步服务。'),
      el('div',{class:'actions'},button('上传到服务器',()=>sync?.run('upload'),{disabled:!sync}),button('从服务器下载',()=>sync?.run('download'),{disabled:!sync}),button('查看保留的副本',syncCopies),button('下载同步前备份',recovery)),
      el('p',{class:'muted'},'请养成定期备份的习惯，重要修改前建议先备份全部资料。'));
  }
  function settingsPage() {
    const s = state.settings;
    const update = (key, value) => { s[key] = value; scheduleSave(); };
    const settingNumber = (title, key, min, max, hint) => label(title, el('input', { type: 'number', min, max, value: s[key], onInput: e => { const v = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(v) && v >= min && v <= max) update(key, Math.floor(v)); }, onChange: e => { const v = Number(e.target.value); if (!Number.isFinite(v) || v < min || v > max) { e.target.value = s[key]; return notify(`${title}需在 ${min}–${max} 之间。`, true); } update(key, Math.floor(v)); } }), hint);
    const keyInput = el('input', { type: 'password', autocomplete: 'off', value: host.getKey(), placeholder: 'API Key', onInput: e => { try { host.setKey(e.target.value.trim()); } catch (error) { report(error); } } });
    const apiActions = el('div', { class:'api-actions' });
    const connectionStatus = el('small', { class:'model-status', role:'status', 'data-connection-status':true });
    const connectionKey=()=>JSON.stringify([s.apiMode,s.endpoint,s.model]);
    const testConnection = button('测试连接', () => action(async () => {
      if (task) throw new Error('请先完成当前生成。');
      const tested=connectionKey();testConnection.disabled=true;
      connectionStatus.textContent='正在测试连接…';
      try {
        await probeConnection(host,s);
        connectionStatus.textContent=connectionKey()===tested?'连接测试成功。':'连接设置已改变，请重新测试。';
      } catch(error) {
        report(error,'测试连接');
        connectionStatus.textContent=connectionKey()===tested?state.errors[0].message:'连接设置已改变，请重新测试。';
      } finally { testConnection.disabled=false; }
    }), { class:'outline' });
    const apiFields = el('div');
    const refreshApiFields = () => {
      apiActions.replaceChildren(testConnection);
      if (s.apiMode !== 'independent') { apiFields.replaceChildren(el('p', { class: 'muted' }, '支持酒馆 Chat Completion 连接。正文生成时等待；可在独立 API 下同时生成。')); return; }
      const modelsArea = el('div');
      const refreshModels = () => {
        const values = s.modelsEndpoint === s.endpoint ? [...s.models] : [];
        if (s.model && !values.includes(s.model)) values.unshift(s.model);
        modelsArea.replaceChildren(dropdownField('模型', singleChoice('选择模型', [{ value: '', label: values.length ? '请选择模型' : '请先拉取模型' }, ...values.map(value => ({ value, label: value }))], s.model, value => update('model', value))));
      };
      const fetchModels = button('拉取模型', async () => {
        const endpoint = s.endpoint, controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        fetchModels.disabled = true; fetchModels.textContent = '拉取中…'; modelStatus.textContent = '';
        try {
          const models = await host.listModels(endpoint, { signal: controller.signal });
          if (s.endpoint !== endpoint) return;
          s.models = models; s.modelsEndpoint = endpoint;
          if (!models.includes(s.model)) s.model = '';
          await persist(); refreshModels(); modelStatus.textContent = '已拉取 ' + models.length + ' 个模型，请选择。';
        } catch (error) { if (error.name === 'AbortError') error = new Error('拉取模型超时，请稍后重试。'); report(error, '拉取模型'); modelStatus.textContent = state.errors[0].message; }
        finally { clearTimeout(timer); fetchModels.disabled = false; fetchModels.textContent = '拉取模型'; }
      }, { class: 'outline' });
      const modelStatus = el('small', { class: 'model-status', 'aria-live': 'polite' });
      refreshModels();
      apiActions.replaceChildren(fetchModels, testConnection);
      apiFields.replaceChildren(el('div', { class: 'form-grid' }, label('API 地址', el('input', { type: 'url', placeholder: 'https://example.com/v1', value: s.endpoint, onInput: e => { update('endpoint', e.target.value); s.model = ''; refreshModels(); scheduleSave(); } })), label('API 密钥', keyInput, '密钥保存在当前浏览器，不进入番外、主题或备份。'), modelsArea), modelStatus);
    };
    const apiChoice = singleChoice('生成连接', [{ value: 'main', label: '跟随主 API · 与正文轮流生成' }, { value: 'independent', label: '独立 API · 可与正文同时请求' }], s.apiMode, value => { update('apiMode', value); refreshApiFields(); });
    refreshApiFields();
    const restore = el('input', { type: 'file', accept: '.json,application/json', hidden: true, onChange: e => action(async () => {
      const file = e.target.files?.[0]; if (!file) return; if (file.size > 50000000) throw new Error('备份超过 50 MB，基础版暂不支持导入。');
      const incoming = normalizeState(JSON.parse(await file.text())); incoming.themes = incoming.themes.map(validateTheme);
      confirm('恢复备份', `将替换当前资料库为 ${incoming.stories.length} 篇番外、${incoming.categories.length} 个分类。恢复前会自动下载当前备份。`, async () => {
        if (task) throw new Error('请先停止生成再恢复备份。');
        download(backup(state), `瞬息-恢复前备份-${Date.now()}.json`, 'application/json');
        await store.save(incoming,{syncMeta:null}); state = incoming; storyId = state.stories[0]?.id || null; root.dataset.theme = state.settings.theme; launcher.hidden = !state.settings.launcherEnabled; nativePanel?.sync(state.settings.launcherEnabled); render(); notify('备份已恢复。');
      });
    }) });
    return el('section', { class: 'page settings-page' }, el('div', { class: 'page-heading' }, el('h1', {}, '设置'), button('刷新酒馆资料', () => refreshCatalog(), { class: 'text-button' })),
      el('section', { class: 'settings-group' }, el('h2', {}, '人物与资料'),
        el('div', { class: 'sources-compact' }, sourceRow('当前角色', el('div', { class: 'source-text' }, el('strong', {}, catalog.currentCharacter || '未打开角色聊天'))),
          sourceRow('当前面具', el('div', { class: 'source-text persona-current' }, el('strong', {}, s.personaMode === 'custom' ? s.customPersonaName || '我' : catalog.currentPersona || '我'), (() => { const arrow = button('', editPersona, { class: 'source-arrow icon-button', 'aria-label': '编辑当前面具' }); arrow.innerHTML = phoneIcon('arrow'); return arrow; })())),
          sourceSelector('preset'), regexSelector(), regexSelector('character'), sourceSelector('book')),
        el('div', { class: 'context-row' }, el('label', { class: 'check-row' }, el('input', { type: 'checkbox', checked: s.readContext, onChange: e => { update('readContext', e.target.checked); render(); } }), '读取正文上下文'),
          el('input', { type: 'number', min: 1, max: 200, value: s.contextCount, disabled: !s.readContext, 'aria-label': '读取最近消息数', onChange: e => { update('contextCount', Math.min(200, Math.max(1, Math.floor(Number(e.target.value)) || 10))); e.target.value = s.contextCount; } }), el('small', {}, '条'))),
      el('section', { class: 'settings-group' }, el('h2', {}, '生成参数'),
        el('div', { class: 'parameter-pair' }, settingNumber('目标正文字数', 'words', 100, 20000), settingNumber('目标消息条数', 'targetMessages', 1, 1000)),
        el('small', { class: 'shared-hint' }, '正文／小手机不足时自动补足；中断后可继续补足，生成与续写共用。HTML 不按字数或条数补写。'),
        el('div', { class: 'parameter-pair reply-parameters' }, settingNumber('最大回复token', 'maxTokens', 128, 200000), el('label', { class: 'stream-setting' }, el('input', { type: 'checkbox', checked: s.stream, onChange: e => update('stream', e.target.checked) }), el('span', {}, '流式传输')))),
      el('section', { class: 'settings-group' }, el('h2', {}, 'API'), dropdownField('生成连接', apiChoice), apiFields, apiActions, connectionStatus),
      stickerLibrary(),
      el('section', { class: 'settings-group' }, el('h2', {}, '数据'), syncPanel(),
        el('div', { class: 'actions' }, button('按分类导出 ZIP', exportCategories), button('备份全部资料', () => download(backup(state), `瞬息-备份-${new Date().toISOString().slice(0, 10)}.json`, 'application/json')), button('恢复备份', () => restore.click(), { disabled: Boolean(task) })), restore,
        ),
      el('section', { class: 'settings-group update-group' }, el('h2', {}, '更新'), el('p', {}, `当前版本 · ${VERSION}`), el('p', { class: 'muted' }, '1.0.14：适配 TauriTavern 手机安全区，修复顶栏遮挡，增大收起按钮。'), button('检查更新', () => action(async () => { notify('正在检查更新…'); notify(await host.checkUpdate()); }))),
      el('section', { class: 'settings-group' }, el('h2', {}, '报错记录'), el('div', { class: 'error-list', 'aria-live': 'polite' }, errorRows())));
  }
  function exportCategories() {
    const choices = [...state.categories, { id: 'uncategorized', name: '未分类' }], selected = new Set(choices.map(c => c.id));
    let pop; pop = popup('按分类导出', el('div', {}, el('p', {}, 'ZIP 解压后按分类展示，同篇在多个分类下各保留一份。阅读文件不展示标签。'), el('div', { class: 'choice-list' }, choices.map(c => el('label', { class: 'check-row' }, el('input', { type: 'checkbox', checked: true, onChange: e => e.target.checked ? selected.add(c.id) : selected.delete(c.id) }), c.name))), el('small', {}, '导出 HTML 自带阅读样式；外部图片仍需网络。本功能不是完整备份。')), [button('取消', () => pop.close()), button('导出 ZIP', () => action(async () => {
      if (!selected.size) throw new Error('请至少选择一个分类。');
      download(makeZip(categoryFiles(state, [...selected])), `瞬息-分类导出-${new Date().toISOString().slice(0, 10)}.zip`, 'application/zip'); pop.close(); notify('分类导出已开始下载。');
    }), { class: 'primary' })]);
  }
  function placeLauncher() {
    const position = state.settings.launcher, size = 32;
    const x = Math.max(8, Math.min(innerWidth - size - 8, position.x ?? innerWidth - size - 18));
    const y = Math.max(8, Math.min(innerHeight - size - 8, position.y ?? innerHeight * 0.65));
    launcher.style.left = `${x}px`; launcher.style.top = `${y}px`;
  }
  let drag = null, wasDragged = false;
  launcher.addEventListener('pointerdown', e => { if (e.button !== 0) return; drag = { x: e.clientX, y: e.clientY, left: parseFloat(launcher.style.left), top: parseFloat(launcher.style.top) }; wasDragged = false; launcher.setPointerCapture(e.pointerId); });
  launcher.addEventListener('pointermove', e => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) < 6 && !wasDragged) return; wasDragged = true; state.settings.launcher = { x: drag.left + dx, y: drag.top + dy }; placeLauncher(); });
  launcher.addEventListener('pointerup', () => { if (wasDragged) scheduleSave(); drag = null; });
  launcher.addEventListener('pointercancel', () => { drag = null; });
  launcher.addEventListener('click', e => { if (wasDragged) { e.stopImmediatePropagation(); e.preventDefault(); wasDragged = false; } }, true);
  const flushInputs = () => { try { store.checkpoint(state); } catch (error) { report(error, '保存'); } };
  const onVisibilityChange = () => { if (document.visibilityState === 'hidden') { flushInputs(); persist().catch(report); } };
  const beforeUnload = e => { flushInputs(); if (task || editing) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('resize', placeLauncher); window.addEventListener('beforeunload', beforeUnload);
  launcher.hidden = state.settings.launcherEnabled === false;
  try { nativePanel = host.mountSettingsPanel?.({ enabled: !launcher.hidden, setEnabled: setLauncherEnabled }); } catch (error) { report(error); }
  window.addEventListener('pagehide', flushInputs); document.addEventListener('visibilitychange', onVisibilityChange);
  const refreshSyncStatus = value => {
    for(const node of shadow.querySelectorAll('[data-sync-status]'))node.textContent=value.text;
    // Prevent edits while awaiting the atomic commit. Closing/reloading still leaves
    // the last committed library or its pending-input journal recoverable.
    const busy=value.kind==='syncing';content.inert=busy;nav.inert=busy;themeButton.disabled=busy;
  };
  if(host.libraryRemote) {
    sync=new LibrarySync({store,remote:host.libraryRemote(),getState:()=>state,prepare:persist,
      canApply:()=>!disposed&&!task&&!editing&&!busyAction&&!shadow.querySelector('.popup[open]'),
      onStatus:refreshSyncStatus,onError:error=>report(error,'跨设备同步'),
      apply:async(shared,metadata,guard)=>{
        const changed=!equalSync(sharedState(state),shared),next=applyShared(state,shared);
        const recovery=changed||!await store.syncRecovery();
        await store.save(next,{syncMeta:metadata,recovery,...guard});
        state=next;
        if(!state.stories.some(story=>story.id===storyId))storyId=state.stories[0]?.id||null;
        chapterIndex=Math.min(chapterIndex,Math.max(0,(current()?.chapters.length||1)-1));
        root.dataset.theme=state.settings.theme;themeButton.textContent=state.settings.theme==='night'?'☾':'☼';
        if(changed&&!disposed)render();
      }
    });
  }
  placeLauncher(); render();
  host.onCharacterChange?.(() => { refreshCatalog(false); });
  await refreshCatalog(false);
  if (preview) open();
  return { open, async dispose() { disposed = true; sync?.dispose(); stop(); filterObserver.disconnect(); filterLayouts.clear(); clearTimeout(saveTimer); clearTimeout(noticeTimer); await store.save(state).catch(() => {}); await store.close(); host.dispose(); window.removeEventListener('message', onReaderMessage); window.removeEventListener('resize', placeLauncher); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('pagehide', flushInputs); document.removeEventListener('visibilitychange', onVisibilityChange); nativePanel?.dispose(); root.remove(); } };
}
