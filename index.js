import { mount } from './src/app.js';
import { TavernHost } from './src/host.js';

let starting = false;
async function start() {
  if (starting || document.getElementById('shunxi-extension-root')) return;
  starting = true;
  let host;
  try {
    host = new TavernHost(() => globalThis.SillyTavern.getContext(), import.meta.url);
    await host.initialize();
    await mount(host);
  } catch (error) {
    host?.dispose();
    console.error('[瞬息] 初始化失败', error);
    globalThis.toastr?.error(error.message, '瞬息初始化失败');
    starting = false;
  }
}
const context = globalThis.SillyTavern?.getContext?.();
if (context?.eventSource && context?.eventTypes?.APP_READY) {
  // APP_READY is sticky in SillyTavern 1.14.0 and later; late subscribers also run.
  context.eventSource.on(context.eventTypes.APP_READY, start);
} else console.error('[瞬息] 请作为 SillyTavern 1.14.0 或兼容版本的原生扩展安装。');
