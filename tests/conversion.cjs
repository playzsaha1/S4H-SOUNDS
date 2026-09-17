// Deterministic conversion lifecycle tests without a browser. The browser suite
// separately covers actual decoding, layout, accessibility and file downloads.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('app.js', 'utf8');
class Element {
  constructor() { this.children = []; this.dataset = {}; this.attributes = {}; this.hidden = true; this.disabled = false; this.textContent = ''; this.classList = {add(){},remove(){},toggle(){}}; }
  append(...els) { for (const el of els) { el.parent = this; this.children.push(el); } }
  prepend(el) { el.parent = this; this.children.unshift(el); }
  replaceChildren(...els) { this.children = []; this.append(...els); }
  remove() { this.parent.children = this.parent.children.filter(el => el !== this); }
  get lastChild() { return this.children.at(-1); }
  setAttribute(key, val) { this.attributes[key] = val; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener() {}
  focus() {}
}
const decoded = { duration:1, length:4, numberOfChannels:1, sampleRate:48000, getChannelData:() => new Float32Array([0, .5, -.5, 0]) };
function setup({decode=async()=>decoded, failWorker=false, offline=false, lostResponse=false}={}) {
  const nodes = new Map(), requests = [], tokens = new Set(), downloads = new Set(); let total = 0, attempts = 0, contextsClosed = 0;
  const node = id => { if (!nodes.has(id)) nodes.set(id,new Element()); return nodes.get(id); };
  const context = vm.createContext({
    console, Blob, Uint8Array, Float32Array, ArrayBuffer, setTimeout, clearTimeout, setInterval:()=>0, AbortController,
    document: { getElementById:node, querySelectorAll:()=>[], createElement:()=>new Element(), addEventListener(){}, body:new Element() },
    location:{pathname:'/'}, history:{pushState(){}}, localStorage:{getItem:()=>null,setItem(){}},
    window:{AudioContext:class { constructor(){this.state='running';} decodeAudioData(b){return decode(b);} async close(){contextsClosed++;this.state='closed';} }, addEventListener(){},scrollTo(){}},
    URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},
    Worker:class { postMessage(){queueMicrotask(()=>failWorker ? this.onerror() : this.onmessage({data:{blob:new Blob(['RIFFtest'])}}));} terminate(){} },
    fetch:async(path, options)=>{
      if (offline) throw new Error('Offline');
      const body = options.body && JSON.parse(options.body); requests.push({path,body});
      if(path==='/api/ticket')return {ok:true,json:async()=>({token:'t'+requests.length})};
      if(path==='/api/complete'){
        if(!tokens.has(body.token)){tokens.add(body.token);total++;}
        if(lostResponse && !attempts++)throw new Error('Lost acknowledgement');
      }
      if(path==='/api/download') downloads.add(body.token);
      return {ok:true,json:async()=>({total,downloads:downloads.size})};
    }
  });
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  const file = {name:'tone.mp3',size:12,arrayBuffer:async()=>new Uint8Array([73,68,51,0]).buffer};
  context.fixture = file;
  run('selectFile(fixture)');
  return {node,run,context,requests,total:()=>total,closed:()=>contextsClosed};
}
test('successful output records once; a lost response retries only the same token',async()=>{
  const app=setup({lostResponse:true}); await app.run('convert()');
  assert.equal(app.total(),1);
  const posts=app.requests.filter(r=>r.path==='/api/complete');
  assert.equal(posts.length,2); assert.equal(posts[0].body.token,posts[1].body.token);
  assert.deepEqual(Object.keys(posts[0].body),['token']);
  assert.equal(app.node('result').hidden,false); assert.equal(app.closed(),1);
});
test('decode failure, encoder failure and cancellation do not increment',async()=>{
  const failure=setup({decode:async()=>{throw new Error('Corrupt');}}); await failure.run('convert()');
  assert.equal(failure.total(),0); assert.match(failure.node('statusText').textContent,/could not be decoded/);
  const encoder=setup({failWorker:true}); await encoder.run('convert()');
  assert.equal(encoder.total(),0); assert.match(encoder.node('statusText').textContent,/WAV encoding failed/);
  let release; const cancelled=setup({decode:()=>new Promise(resolve=>release=resolve)});
  const pending=cancelled.run('convert()');
  while(!release) await new Promise(resolve=>setImmediate(resolve));
  assert.equal(cancelled.node('convertBtn').disabled,true);
  cancelled.node('cancelBtn').onclick(); release(decoded); await pending;
  assert.equal(cancelled.total(),0); assert.equal(cancelled.node('result').hidden,true);
  assert.match(cancelled.node('statusText').textContent,/cancelled/); assert.equal(cancelled.closed(),1);
});
test('double click does not start a second conversion; repeated completed conversions count separately',async()=>{
  let release; const app=setup({decode:()=>new Promise(resolve=>release=resolve)});
  const first=app.run('convert()'); await app.run('convert()');
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  release(decoded); await first; assert.equal(app.total(),1);
  const second=app.run('convert()');
  await new Promise(resolve=>setImmediate(resolve)); release(decoded); await second;
  assert.equal(app.total(),2);
});
test('counter outage still creates a usable output; invalid input clears a previous file',async()=>{
  const app=setup({offline:true}); await app.run('convert()');
  assert.equal(app.node('result').hidden,false); assert.match(app.node('counterNote').textContent,/not recorded/);
  app.run("selectFile({name:'bad.txt',size:3})");
  assert.equal(app.node('convertBtn').disabled,true); assert.equal(app.run('state.file'),null);
});
test('XML escapes untrusted filenames and uses decoded properties',async()=>{
  const app=setup(); app.context.fixture.name='a<&"song.mp3';
  app.run("state.format='xml'"); await app.run('convert()'); assert.equal(app.total(),1);
  const text=app.run('xml(fixture, {duration:1.25, sampleRate:48000, numberOfChannels:1, length:60000})');
  assert.match(text,/a&lt;&amp;&quot;song/); assert.match(text,/<channels>1<\/channels>/);
  assert.match(text,/<durationSeconds>1.25<\/durationSeconds>/); assert.doesNotMatch(text,/128 kbps|stereo/);
});
test('real WAV encoder writes valid interleaved PCM headers and clamped samples',async()=>{
  let result;
  const worker=vm.createContext({Blob, ArrayBuffer, DataView, self:{postMessage:value=>result=value}});
  vm.runInContext(fs.readFileSync('encoder-worker.js','utf8'),worker);
  worker.self.onmessage({data:{channels:[new Float32Array([-2,0,2]),new Float32Array([.5,-.5,0])],length:3,sampleRate:44100}});
  const bytes=Buffer.from(await result.blob.arrayBuffer());
  assert.equal(bytes.toString('ascii',0,4),'RIFF'); assert.equal(bytes.toString('ascii',8,12),'WAVE');
  assert.equal(bytes.readUInt32LE(24),44100); assert.equal(bytes.readUInt16LE(22),2);
  assert.equal(bytes.readUInt16LE(34),16); assert.equal(bytes.readUInt32LE(40),12);
  assert.equal(bytes.readInt16LE(44),-32768); assert.equal(bytes.readInt16LE(46),16383);
  assert.equal(bytes.readInt16LE(52),32767); assert.equal(bytes.length,56);
});

test('landing stats use backend values, and repeated download links count the output once',async()=>{
  const app=setup(); await app.run('refreshCount()');
  assert.equal(app.node('landingConversions').textContent,'0');
  assert.equal(app.node('landingDownloads').textContent,'0');
  await app.run('convert()');
  app.node('result').children[0].children[1].onclick();
  app.node('downloadsList').children[0].children[1].onclick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(app.requests.filter(r=>r.path==='/api/download').length,1);
  assert.equal(app.node('landingConversions').textContent,'1');
  assert.equal(app.node('landingDownloads').textContent,'1');
  await app.run('refreshCount()');
  assert.equal(app.requests.filter(r=>r.path==='/api/download').length,1);
});
test('unavailable live stats never display invented zeros',async()=>{
  const app=setup({offline:true}); await app.run('refreshCount()');
  assert.equal(app.node('landingConversions').textContent,'—');
  assert.equal(app.node('landingDownloads').textContent,'—');
  assert.match(app.node('statsStatus').textContent,/unavailable/);
});
