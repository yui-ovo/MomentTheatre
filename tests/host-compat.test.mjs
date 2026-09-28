import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generationStatus, worldInfoNames, chatPayload } from '../src/host-compat.js';
import { TavernHost } from '../src/host.js';

function fixture(source = 'custom', service = null) {
  const storage = new Map([['shunxi.library.scope.v1', 'compat-test']]);
  const context = {
    accountStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    eventSource: new EventEmitter(), eventTypes: { GENERATION_STARTED: 'start', GENERATION_ENDED: 'end', GENERATION_STOPPED: 'stop' },
    mainApi: 'openai', name1: '用户', name2: '角色', characterId: 0,
    characters: [{ avatar: 'card.png', name: '角色', data: { extensions: { world: '人物设定', regex_scripts: [] } } }],
    powerUserSettings: { personas: {} }, unshallowCharacter: async () => {},
    chatCompletionSettings: { chat_completion_source: source, custom_url: 'https://main.invalid/v1', custom_include_headers: 'X-Test: yes', temp_openai: 0.7, top_p_openai: 0.9 },
    // 1.14 takes a source string, not a settings object. No argument works in both versions.
    getChatCompletionModel: (...args) => { assert.equal(args.length, 0); return 'test-model'; },
    ChatCompletionService: service || { presetToGeneratePayload: (preset) => ({ temperature: preset.temperature }), sendRequest: async () => { throw new Error('unexpected request'); } },
  };
  const host = new TavernHost(() => context, import.meta.url);
  host.worldInfo = { world_names: ['人物设定', '补充设定'], world_info: { charLore: [{ name: 'card', extraBooks: ['补充设定'] }] } };
  host.characterUtils = { getCharaFilename: () => 'card' };
  host.isGenerating = () => false;
  host.getKey = () => 'test-only-independent-key';
  return { context, host };
}
const messages = [{ role: 'system', content: '写番外' }, { role: 'user', content: '海边' }];
const settings = { apiMode: 'main', maxTokens: 500, stream: false };

test('initialization loads legacy module bindings and skips legacy imports for modern hosts', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'momenttheatre-compat-'));
  try {
    // URL depths match /scripts/extensions/third-party/MomentTheatre/index.js.
    const extensionUrl = pathToFileURL(join(temp, 'a/b/c/d/index.js')).href;
    const files = { '../../../../script.js': 'export let is_send_press=false; export let streamingProcessor=null;',
      '../../../group-chats.js': 'export let is_group_generating=false;', '../../../world-info.js': 'export const world_names=[];', '../../../utils.js': 'export const getCharaFilename=()=>"card";' };
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(temp, 'a'), {recursive:true});
    for (const [relative, code] of Object.entries(files)) await writeFile(new URL(relative, extensionUrl), code);
    const {host} = fixture(); host.extensionUrl=extensionUrl; await host.initialize();
    assert.equal(host.isMainBusy(),false); assert.deepEqual(worldInfoNames({},host.worldInfo),[]); host.dispose();
    // A separate root avoids the ESM module cache of the legacy script.
    const modernRoot=join(temp,'modern'); await mkdir(join(modernRoot,'a'),{recursive:true});
    const modernUrl=pathToFileURL(join(modernRoot,'a/b/c/d/index.js')).href;
    await writeFile(new URL('../../../../script.js',modernUrl),'export const isGenerating=()=>true;');
    await writeFile(new URL('../../../world-info.js',modernUrl),'export const world_names=[];');
    await writeFile(new URL('../../../utils.js',modernUrl),'export const getCharaFilename=()=>"card";');
    const modern=fixture().host; modern.extensionUrl=modernUrl; await modern.initialize();
    assert.equal(modern.isMainBusy(),true); modern.dispose();
  } finally {
    assert.equal(resolve(temp).startsWith(resolve(tmpdir()) + (process.platform==='win32'?'\\':'/')),true);
    await rm(temp,{recursive:true,force:true});
  }
});

test('legacy live generation flags handle group, stream, and stopped states', () => {
  const core = { is_send_press: false, streamingProcessor: null }, groups = { is_group_generating: false };
  const busy = generationStatus(core, groups);
  assert.equal(busy(), false);
  core.is_send_press = true; assert.equal(busy(), true);
  core.is_send_press = false; groups.is_group_generating = true; assert.equal(busy(), true);
  groups.is_group_generating = false; core.streamingProcessor = { isFinished: false, isStopped: false }; assert.equal(busy(), true);
  core.streamingProcessor.isStopped = true; assert.equal(busy(), false);
  assert.throws(() => generationStatus({}, {}), /状态接口/);
});
test('modern helpers take precedence; legacy world list follows replacements without exposing mutable source', () => {
  assert.equal(generationStatus({ isGenerating: () => true }, null)(), true);
  const world = { world_names: ['A'] };
  worldInfoNames({}, world).push('not shared'); assert.deepEqual(world.world_names, ['A']);
  world.world_names = ['B']; assert.deepEqual(worldInfoNames({}, world), ['B']);
  assert.deepEqual(worldInfoNames({ getWorldInfoNames: () => ['C'] }, world), ['C']);
  assert.throws(() => worldInfoNames({}, {}), /尚未就绪/);
});
test('1.14 catalog loads character-linked books without getWorldInfoNames', async () => {
  const {host} = fixture();
  const result = await host.catalog();
  assert.deepEqual(result.characterSources.books, ['人物设定', '补充设定']);
  assert.deepEqual(result.books.map(x => x.value), ['人物设定', '补充设定']);
  host.dispose();
});
test('legacy main generation sends endpoint, model, prompt and sampling overrides without changing settings', async () => {
  const {context,host} = fixture(); const before = structuredClone(context.chatCompletionSettings);
  context.ChatCompletionService.sendRequest = async (payload, extract) => {
    assert.equal(extract, true); assert.equal(payload.chat_completion_source, 'custom');
    assert.equal(payload.custom_url, before.custom_url); assert.equal(payload.custom_include_headers, before.custom_include_headers);
    assert.equal(payload.model, 'test-model'); assert.deepEqual(payload.messages, messages);
    assert.equal(payload.temperature, 0.3); assert.equal(payload.top_p, 0.9);
    assert.equal(payload.max_tokens, 500); assert.equal(payload.stream, false);
    return {content:'海边番外'};
  };
  assert.equal(await host.generate({messages,settings,snapshot:{preset:{temperature:0.3}}}), '海边番外');
  assert.deepEqual(context.chatCompletionSettings,before); host.dispose();
});
test('legacy independent streaming keeps its own endpoint and authorization', async () => {
  const {context,host} = fixture(); const chunks=[];
  context.ChatCompletionService.sendRequest = async payload => {
    assert.equal(payload.custom_url,'https://independent.invalid/v1');
    assert.deepEqual(JSON.parse(payload.custom_include_headers),{Authorization:'Bearer test-only-independent-key'});
    return async function*(){yield {text:'海'};yield {text:'海边番外'};};
  };
  assert.equal(await host.generate({messages,settings:{...settings,apiMode:'independent',model:'independent',endpoint:'https://independent.invalid/v1',stream:true},onChunk:t=>chunks.push(t)}),'海边番外');
  assert.deepEqual(chunks,['海','海边番外']); host.dispose();
});
test('main request refuses busy chat and aborts on a subsequent real generation', async () => {
  const {context,host} = fixture(); host.isGenerating=()=>true;
  await assert.rejects(host.generate({messages,settings}),/正文正在生成/);
  host.isGenerating=()=>false;
  context.ChatCompletionService.sendRequest=async (_payload,_extract,signal)=>{
    context.eventSource.emit('start','normal',{},true); assert.equal(signal.aborted,false);
    context.eventSource.emit('start','normal',{},false); assert.equal(signal.aborted,true);
    return {content:'discard'};
  };
  await assert.rejects(host.generate({messages,settings}),{name:'AbortError'});
  assert.equal(context.eventSource.listenerCount('start'),1); host.dispose();
  assert.equal(context.eventSource.listenerCount('start'),0);
});
test('modern request conversion remains authoritative', async () => {
  const {context} = fixture(); let received;
  const expected={chat_completion_source:'custom',messages,modern:true};
  context.ChatCompletionService.presetToGeneratePayload=async (...args)=>{received=args;return expected;};
  const overrides={messages,model:'modern',max_tokens:123,stream:true};
  assert.equal(await chatPayload(context,{temperature:0.2},overrides),expected);
  assert.deepEqual(received,[{temperature:0.2},{},overrides]);
});
test('legacy provider routing and reasoning model constraints do not mutate messages', async () => {
  for(const source of ['openai','claude','makersuite','vertexai','openrouter','azure_openai']) {
    const {context}=fixture(source); Object.assign(context.chatCompletionSettings,{reverse_proxy:'https://proxy.invalid',proxy_password:'test',vertexai_region:'us-central1',azure_base_url:'https://azure.invalid',openrouter_providers:['example']});
    const payload=await chatPayload(context,{}, {messages,model:source==='openai'?'o1':'test-model',max_tokens:500,stream:true});
    assert.equal(payload.chat_completion_source,source);
    if(source==='openai'){assert.equal(payload.max_completion_tokens,500);assert.equal(payload.stream,false);assert.equal(payload.messages[0].role,'user');assert.equal(payload.temperature,undefined);}
    if(source==='claude')assert.equal(payload.claude_use_sysprompt,true);
    if(source==='vertexai')assert.equal(payload.vertexai_region,'us-central1');
    if(source==='azure_openai')assert.equal(payload.azure_base_url,'https://azure.invalid');
    if(source==='openrouter')assert.deepEqual(payload.provider,['example']);
  }
  assert.equal(messages[0].role,'system');
});
