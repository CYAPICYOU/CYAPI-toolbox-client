// Windows/WebView2 UI regression with an isolated profile and deferred mock
// control responses. No real Key, model call, remote workspace or billing.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

if (process.platform !== 'win32') throw new Error('Requires Windows/WebView2');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.resolve(
  root,
  process.argv[2] || 'src-tauri/target/release/cyapi-toolbox.exe',
);
const output = path.join(root, 'output/workflow-startup-check', crypto.randomUUID());
await mkdir(output, { recursive: true });
const port = 19432;
try {
  await fetch(`http://127.0.0.1:${port}/json/list`);
  throw new Error('CDP port in use; refusing to attach to an existing browser');
} catch (error) {
  if (!error.cause) throw error;
}
const editor = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end('<!doctype html><title>Startup test editor</title><h1>Isolated editor window</h1>');
});
await new Promise((resolve) => editor.listen(0, '127.0.0.1', resolve));
const editorUrl = `http://127.0.0.1:${editor.address().port}/workflow/?t=mock-one-shot`;
const child = spawn(executable, [], {
  cwd: root,
  env: {
    ...process.env,
    CYAPI_TOOLBOX_LOCAL_TEST_ROOT: output,
    CYAPI_TOOLBOX_HOME_DIR: path.join(output, 'home'),
    CYAPI_TOOLBOX_DATA_DIR: path.join(output, 'data'),
    WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  },
  stdio: 'ignore',
});
const sockets = [];
const checks = [];
const check = (name, result) => {
  assert.ok(result, name);
  checks.push(name);
  console.log('PASS ' + name);
};
async function until(action, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await action();
    if (value) return value;
    await delay(100);
  }
  throw new Error('Desktop condition timed out');
}
async function pages() {
  try {
    return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  } catch {
    return [];
  }
}
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  sockets.push(ws);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ({ data }) => {
    const result = JSON.parse(data),
      task = pending.get(result.id);
    if (!task) return;
    pending.delete(result.id);
    clearTimeout(task.timer);
    if (result.error) task.reject(new Error(result.error.message));
    else task.resolve(result.result);
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const next = ++id;
      const timer = setTimeout(() => {
        pending.delete(next);
        reject(new Error('CDP timeout: ' + method));
      }, 15000);
      pending.set(next, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: next, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description || result.exceptionDetails.text,
      );
    return result.result.value;
  };
  return { call, evaluate };
}
let main;
try {
  main = await connect(
    await until(async () =>
      (await pages()).find((page) => page.url.startsWith('http://tauri.localhost')),
    ),
  );
  await until(() => main.evaluate("Boolean(document.querySelector('.n-workbenches'))"));
  await main.call('Page.enable');
  const injection = `(() => {
    localStorage.setItem('cyapi.workbenches.v1',JSON.stringify({workbench:'create',creationSection:'library'}));
    localStorage.setItem('cyapi.workflows.keys.v1',JSON.stringify({keys:[{id:'test',name:'Isolated mock',key:'not-a-real-user-key',createdAt:1}],activeId:'test'}));
    const realFetch=window.fetch.bind(window);
    const template={id:'startup-test',title:'启动交互验收',description:'隔离测试',category:'text',version:'1',source:'server',kind:'text',input:'文本',output:'文本',steps:['输入','输出'],form:{prompt:{label:'提示词',placeholder:'输入',required:true}},execution:'preview',workflow:{nodes:[],links:[]}};
    window.__startup={calls:0,fail:false,complete:null,aborted:0};
    window.fetch=(url,options={})=>{
      const pathname=new URL(String(url),location.href).pathname;
      if(!pathname.includes('/workflow/platform/api/'))return realFetch(url,options);
      const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
      if(pathname.endsWith('/public/catalog'))return Promise.resolve(json({version:1,categories:[],items:[template]}));
      if(pathname.endsWith('/editor-token')){
        window.__startup.calls++;
        if(window.__startup.fail)return Promise.resolve(json({error:{message:'测试启动失败',code:'mock_failure'}},503));
        return new Promise((resolve,reject)=>{
          window.__startup.complete=()=>resolve(json({url:${JSON.stringify(editorUrl)},expiresIn:60}));
          options.signal?.addEventListener('abort',()=>{window.__startup.aborted++;reject(new DOMException('aborted','AbortError'));},{once:true});
        });
      }
      return Promise.resolve(json({user:{id:'test'},workspace:{status:'stopped'},backend:'remote',workspaceCapacity:{maxConcurrent:1,running:0},editor:{path:'/workflow',tokenTtlSeconds:60}}));
    };
  })();`;
  await main.call('Page.addScriptToEvaluateOnNewDocument', { source: injection });
  await main.evaluate(injection);
  await main.call('Page.reload');
  await until(() => main.evaluate("Boolean(document.querySelector('.pfx-template'))"));
  const clickText = (text) =>
    main.evaluate(
      `(() => {const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)throw Error('missing button');b.click();return true;})()`,
    );
  check(
    'global toolbox log entry is available from the workflow workbench',
    await main.evaluate("Boolean(document.querySelector('.n-sidebar-tools [data-logs-trigger]'))"),
  );
  await clickText('使用模板');
  await clickText('在 ComfyUI 中打开');
  await until(() => main.evaluate("Boolean(document.querySelector('.pfx-launch-starting'))"));
  check(
    'startup feedback appears immediately while the control request is pending',
    await main.evaluate(
      "Boolean(document.querySelector('[role=progressbar]')) && window.__startup.calls===1",
    ),
  );
  check(
    'no blocking modal and editing remains enabled',
    await main.evaluate(
      "!document.querySelector('[aria-modal=true]') && !document.querySelector('#workflow-prompt').disabled",
    ),
  );
  check(
    'all duplicate editor launch controls disabled',
    await main.evaluate(
      "Array.from(document.querySelectorAll('.pfx-workflow-heading button')).every(b=>b.disabled)",
    ),
  );
  await until(() =>
    main.evaluate("/已等待 [1-9]/.test(document.querySelector('.pfx-launch-copy').textContent)"),
  );
  check('elapsed time keeps updating without freezing WebView2', true);
  if (process.argv.includes('--global-logs')) {
    await main.evaluate(
      "Array.from(document.querySelectorAll('.n-workbenches button')).find(b=>b.textContent.includes('工具接入')).click();true",
    );
    await until(() =>
      main.evaluate(
        "document.querySelector('.n-creation-host')?.hidden && Boolean(document.querySelector('.pfx-launch-starting'))",
      ),
    );
    check('startup progress remains at application root after switching to Tools', true);
    await main.evaluate(
      "document.querySelector('.pfx-launch-notice [data-logs-trigger]').click();true",
    );
    await until(() =>
      main.evaluate(
        "document.querySelector('.d-log-list')?.textContent.includes('开始后台启动 ComfyUI')",
      ),
    );
    check('existing global log window includes the current workflow launch', true);
    await main.evaluate("document.querySelector('[aria-label=关闭日志窗口]').click();true");
    await main.evaluate(
      "Array.from(document.querySelectorAll('.n-workbenches button')).find(b=>b.textContent.includes('工作流')).click();true",
    );
    await until(() => main.evaluate("!document.querySelector('.n-creation-host')?.hidden"));
  }
  await clickText('返回工作流库');
  await until(() => main.evaluate("Boolean(document.querySelector('[aria-label=搜索工作流]'))"));
  check(
    'library navigation remains usable while startup is pending',
    await main.evaluate(
      "!document.querySelector('[aria-label=搜索工作流]').disabled && Boolean(document.querySelector('.pfx-launch-starting'))",
    ),
  );
  const startupShot = await main.call('Page.captureScreenshot', { format: 'png' });
  await writeFile(
    path.join(output, 'startup-nonblocking.png'),
    Buffer.from(startupShot.data, 'base64'),
  );
  await main.evaluate('window.__startup.complete();true');
  await until(() => main.evaluate("Boolean(document.querySelector('.pfx-launch-opened'))"));
  check(
    'successful launch opens a real separate native editor window',
    Boolean(
      await until(async () =>
        (await pages()).find((page) => page.url.startsWith(editorUrl.split('?')[0])),
      ),
    ),
  );
  const editorPage = (await pages()).find((page) => page.url.startsWith(editorUrl.split('?')[0]));
  const remote = await connect(editorPage);
  check(
    'remote editor has no native capability',
    await remote.evaluate(
      "(async()=>{try{await window.__TAURI_INTERNALS__.invoke('plugin:app|version');return false}catch{return true}})()",
    ),
  );
  await until(
    () => main.evaluate("!document.querySelector('.pfx-launch-notice')"),
    8000,
  );
  check('a successful launch closes its notice without leaving a banner behind', true);
  await main.evaluate('window.__startup.fail=true;true');
  await clickText('使用模板');
  await clickText('在 ComfyUI 中打开');
  await until(() => main.evaluate("Boolean(document.querySelector('.pfx-launch-failed'))"));
  check(
    'failure is inline with a dedicated retry action',
    await main.evaluate(
      "document.querySelector('.pfx-launch-failed').textContent.includes('测试启动失败') && Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes('重新尝试'))",
    ),
  );
  await main.evaluate('window.__startup.fail=false;true');
  await clickText('重新尝试');
  await until(() => main.evaluate('window.__startup.calls===3'));
  check(
    'retry requests a fresh one-time token',
    await main.evaluate("Boolean(document.querySelector('.pfx-launch-starting'))"),
  );
  await main.evaluate('window.__startup.complete();true');
  await until(() => main.evaluate("Boolean(document.querySelector('.pfx-launch-opened'))"));
  check('reopening reuses the native editor window', (await pages()).length === 2);
  await until(
    () => main.evaluate("!document.querySelector('.pfx-launch-notice')"),
    8000,
  );
  check('a reopened editor also clears its notice automatically', true);
  await writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(
      {
        executable,
        checks,
        realKeyUsed: false,
        paidCalls: false,
        controlPlane: 'deferred mock',
        nativeEditorWindow: true,
      },
      null,
      2,
    ),
  );
  console.log('Desktop startup report: ' + output);
} catch (error) {
  if (main) {
    console.error(
      await main
        .evaluate(
          "({injected:Boolean(window.__startup),savedKey:Boolean(localStorage.getItem('cyapi.workflows.keys.v1')),url:location.href})",
        )
        .catch(() => null),
    );
    console.error(await main.evaluate('document.body.innerText.slice(0,5000)').catch(() => null));
  }
  throw error;
} finally {
  for (const socket of sockets) socket.close();
  editor.closeAllConnections();
  await new Promise((resolve) => editor.close(resolve));
  if (child.pid && child.exitCode === null)
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}
