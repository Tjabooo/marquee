import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { libraryUnion, libraryAvailability, filterLibrary, transferState } from '../public/library-downloads.js';
const show = { id: 'tv-12', tmdbId: 12, title: 'A series', seasons: [{ number: 1, total: 3 }] };
const film = { id: 'film', title: 'A film', tmdbId: 10, source: 'existing', addedAt: 10 };
const ep = { id: 'ep', show: show.id, title: show.title, season: 1, episode: 1, source: 'added' };
const dl = (hash, extra = {}) => ({ hash, name: 'release', canonicalTitle: 'A film', mediaType: 'movie', tmdbId: 10, progress: .5, size: 100, mine: true, done: false, state: 'downloading', ...extra });
test('unidentified ready film identity survives conversion to an MP4 playback file', () => {
  const original = { id: 'source-mkv', mediaKey: 'stable-media-key', title: 'Sample film' };
  const [before] = libraryUnion([original]);
  const [after] = libraryUnion([{ ...original, id: 'converted-mp4' }]);
  assert.equal(before.key, after.key);
  assert.equal(after.files[0].id, 'converted-mp4', 'playback still uses the newly served file');
});
test('canonical union combines origins, replacement downloads and multiple show seasons without title guessing', () => {
  const entries = libraryUnion([film, { ...film, id: 'copy', source: 'download' }, ep], [show], [dl('film'), dl('s1', { mediaType: 'tv', showId: show.id, tmdbId: 12, season: 1 }), dl('s2', { mediaType: 'tv', showId: show.id, tmdbId: 12, season: 2 }), dl('wrong', { tmdbId: 99 }), dl('other-person', { mine: false })]);
  assert.equal(entries.length, 3);
  const movie = entries.find(e => e.key === 'movie:10'); assert.equal(movie.files.length, 2); assert.equal(movie.transfers.length, 1); assert.equal(movie.ready, true);
  const series = entries.find(e => e.type === 'tv'); assert.equal(series.transfers.length, 2); assert.equal(series.files.length, 1);
  assert.equal(entries.some(e => e.transfers.some(d => d.hash === 'other-person')), false);
});
test('aggregate progress uses selected byte weighting, with unknown sizes remaining indeterminate', () => {
  let [entry] = libraryUnion([], [], [dl('small', { progress: 1, size: 100 }), dl('large', { progress: 0, size: 900 })]);
  assert.equal(entry.progress, .1);
  [entry] = libraryUnion([], [], [dl('small'), dl('unknown', { size: 0 })]); assert.equal(entry.progress, null);
});
test('validated readiness differs from 100 percent, completed external files remain reachable and paused seeds are complete', () => {
  const [preparing] = libraryUnion([], [], [dl('waiting', { progress: 1 })]); assert.equal(preparing.ready, false); assert.equal(preparing.state, 'Almost ready');
  const [external] = libraryUnion([], [], [dl('external', { done: true, ready: true, state: 'stoppedUP' })]); assert.equal(external.ready, true); assert.equal(external.active.length, 0); assert.equal(transferState(external.transfers[0]), 'Complete');
  const [unadmitted] = libraryUnion([], [], [dl('complete-but-missing', { done: true, progress: 1 })]); assert.equal(unadmitted.ready, false); assert.equal(unadmitted.active.length, 1);
});
test('season file evidence reports unique ready and pending episodes; pack progress invents no episode count', () => {
  let [entry] = libraryUnion([ep, { ...ep, id: 'duplicate' }], [show], [dl('season', { mediaType: 'tv', showId: show.id, episodes: [{ season: 1, episode: 1, available: false }, { season: 1, episode: 2, progress: .5 }, { season: 1, episode: 3, progress: 1, available: false }] })]);
  assert.equal(libraryAvailability(entry), '1 ready · 2 downloading');
  [entry] = libraryUnion([ep], [show], [dl('pack', { mediaType: 'tv', showId: show.id, season: 1 })]); assert.equal(libraryAvailability(entry), '1 ready · Season on its way');
});
test('unknown releases stay distinct, queryable and attention/ready filters do not conflate stalled peers with errors', () => {
  const entries = libraryUnion([film], [], [dl('unknown', { mediaType: null, tmdbId: null, canonicalTitle: null, title: null, name: 'Unidentified.release' }), dl('stall', { tmdbId: 22, state: 'stalledDL' }), dl('err', { tmdbId: 23, state: 'missingFiles' })]);
  assert.equal(filterLibrary(entries, { availability: 'attention' }).length, 1);
  assert.equal(filterLibrary(entries, { availability: 'downloading' }).length, 3);
  assert.equal(filterLibrary(entries, { availability: 'ready' }).length, 1);
  assert.equal(filterLibrary(entries, { query: 'unidentified release' })[0].type, 'unknown');
});

const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const between = (a,b) => source.slice(source.indexOf(a), source.indexOf(b,source.indexOf(a)));
class Element {
  constructor(tag='div') { this.tag=tag; this.children=[]; this.attrs={}; this.events={}; this.style={ setProperty() {} }; this.dataset={}; this.hidden=false; this.replacements=0; this._text=''; this.classList={ toggle: (name,on) => { const names = new Set((this.className || '').split(' ').filter(Boolean)); if (on) names.add(name); else names.delete(name); this.className=[...names].join(' '); } }; }
  get childNodes() { return this.children; }
  focus() { if (this.document) this.document.activeElement=this; }
  get firstChild() { return this.children[0]; }
  get textContent() { return this._text + this.children.map(c => c instanceof Element ? c.textContent : String(c)).join(''); }
  set textContent(s) { this._text=String(s); this.children=[]; }
  setAttribute(k,v) { this.attrs[k]=String(v); if(k==='class') this.className=String(v); if(k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  append(...nodes) { for(const n of nodes.flat()) { if(n instanceof Element) { n.remove(); n.parent=this; } this.children.push(n); } }
  insertBefore(n,before) { if(n===before)return; n.remove(); const i=this.children.indexOf(before); this.children.splice(i<0?this.children.length:i,0,n); n.parent=this; }
  remove() { if(this.parent) { const i=this.parent.children.indexOf(this); if(i>=0)this.parent.children.splice(i,1); this.parent=null; } }
  replaceChildren(...nodes) { for(const n of this.children) if(n instanceof Element)n.parent=null; this.children=[];this._text='';this.replacements++;this.append(...nodes); }
  contains(el) { return this===el || this.children.some(c=>c instanceof Element && c.contains(el)); }
  addEventListener(name,fn) { (this.events[name] ||= []).push(fn); }
  click() { return this.events.click?.[0]?.({currentTarget:this}); }
  querySelectorAll(sel) { const matches=e=>sel==='button'?e.tag==='button':sel.startsWith('.')?(e.className || '').split(' ').includes(sel.slice(1)):sel.startsWith('[')?e.getAttribute(sel.slice(1,-1))!=null:e.tag===sel;return this.children.flatMap(c=>c instanceof Element?[...(matches(c)?[c]:[]),...c.querySelectorAll(sel)]:[]); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  get isConnected() { return !!this.parent; }
}
function harness() {
  const nodes = new Map(), opened=[]; const document={activeElement:{},createElement:t=>new Element(t),querySelectorAll:()=>[]};
  const $=(s,el)=>el?el.querySelector(s):(nodes.has(s)?nodes.get(s):(nodes.set(s,new Element()),nodes.get(s)));
  const state={view:'library',status:{library:true},library:[],libraryShows:[],downloads:[dl('new',{poster:'/poster.svg'})],libFilter:'all',libAvailability:'all',progress:{},query:''};
  const context=vm.createContext({ state,document,loadParties(){},newBadgeCount:()=>0,comingUpShelf:()=>null,travelSummary:()=>'',travelView:{items:[]},icon:()=>new Element('span'),openTravelList(){},watch:{revision:0},todayIso:()=>'2026-11-05',Node:Element,$,libraryUnion,libraryAvailability,filterLibrary,librarySignature:'start',libraryProgressRevision:0,libraryRenderPending:false,prefs:()=>({librarySort:'title'}),segmented:(options,value,onPick)=>{const el=new Element();options.forEach(([v,label])=>{const b=new Element('button');b.textContent=label;b.addEventListener('click',()=>onPick(v));el.append(b);});return el;},select:()=>new Element('select'),norm:s=>String(s||'').toLowerCase(),notice:(title,text)=>{const e=new Element();e.textContent=`${title} ${text}`;return e;},nextExpiry:()=>Infinity,libraryFile:f=>({...f,kind:'lib',key:f.id}),savedProgress:()=>null,partlyWatched:()=>false,libraryEntries:()=>[],showView:{id:null},filmView:{id:null},renderConvertBanner(){},openFilm:(f)=>opened.push(['film',f.id]),openShow:id=>opened.push(['show',id]),transferNodes:new Set(),queueMicrotask:fn=>fn(),LIB_FILTERS:[['all','All'],['movie','Films'],['tv','Shows']],plural:(n,w)=>`${n} ${w}`,showSheet:()=>()=>{},pushOverlay(){},renderFilm:()=>opened.push(['pending']),setTimeout,window:{},Date });
  vm.runInContext(between('function h(', 'const ICONS ='),context);
  vm.runInContext(between('const libraryCards =', 'const LIB_FILTERS ='),context);
  return {state,nodes,opened,$,context,run:code=>vm.runInContext(code,context)};
}
test('pending-only Library populates; progress polling retains exact card, poster, toolbar and focused button', () => {
  const h=harness();h.run('renderLibrary()');const card=h.$('#library-body').querySelector('.unified-card'),button=card.querySelector('.title-card'),poster=card.querySelector('.poster'),toolbar=h.$('#library-body').querySelector('.library-toolbar');
  h.context.document.activeElement=button;h.state.downloads[0]={...h.state.downloads[0],progress:.82};h.run('renderLibrary()');
  assert.equal(h.$('#library-body').querySelector('.unified-card'),card);assert.equal(card.querySelector('.poster'),poster);assert.equal(h.$('#library-body').querySelector('.library-toolbar'),toolbar);assert.equal(h.context.document.activeElement,button);assert.equal(card.querySelector('.transfer-percent').textContent,'82%');assert.equal(poster.replacements,1);
  button.click();assert.deepEqual(h.opened,[['pending']]);
});
test('focused completion survives Downloading filter until focus leaves and ready movies survive torrent outage', () => {
  const h=harness();h.state.libAvailability='downloading';h.run('renderLibrary()');const card=h.$('#library-body').querySelector('.unified-card'),button=card.querySelector('.title-card');h.context.document.activeElement=button;
  h.state.library=[film];h.state.downloads=[dl('new',{done:true,ready:true,progress:1})];h.state.downloadsError='Torrent service down';h.run('renderLibrary()');assert.equal(h.$('#library-body').querySelector('.unified-card'),card);assert.equal(card.querySelector('.sub').textContent,'Ready to watch');assert.equal(card.querySelector('.library-transfer').hidden,true,'retained focused card must reflect completion rather than stale download progress');
  h.context.document.activeElement={};h.state.libAvailability='all';h.run('renderLibrary()');assert.equal(h.$('#library-body').querySelectorAll('.unified-card').length,1);assert.match(h.$('#library-body').textContent,/Torrent service down/);button.click();assert.deepEqual(h.opened,[['film','film']]);
});
test('hash metadata promotion retains node and validated ready file playback identity', () => {
  const h=harness();h.state.downloads=[dl('new',{mediaType:null,tmdbId:null})];h.run('renderLibrary()');const card=h.$('#library-body').querySelector('.unified-card');
  h.state.library=[film];h.state.downloads=[dl('new',{libraryIds:[film.id],done:true,ready:true})];h.run('renderLibrary()');assert.equal(h.$('#library-body').querySelector('.unified-card'),card);card.querySelector('.title-card').click();assert.deepEqual(h.opened,[['film','film']]);
});
test('pause failures retain a local error and retryable controls while pending poll cannot hide action state', async () => {
  let reject,observed;const pending=new Promise((_,r)=>{reject=r;});const d=dl('one');const context=vm.createContext({document:{activeElement:null,body:{}},state:{downloads:[d]},api:()=>pending,jsonPost:body=>body,patchTransferNodes(){observed=vm.runInContext("transferOperations.get('one')?.label",context);},patchUnifiedLibrary(){},isPaused:()=>false});
  vm.runInContext(between('const transferOperations =','function openDeleteDownload'),context);const operation=vm.runInContext("togglePause(state.downloads[0])",context);assert.equal(observed,'Pausing…');reject(Error('Unavailable'));await operation;assert.equal(vm.runInContext("transferOperations.get('one').error",context),'Unavailable');assert.equal(vm.runInContext("transferOperations.get('one').label",context),'');
});

function managerHarness({ failure = false, request = null } = {}) {
  const nodes=new Map(),calls=[];const document={activeElement:null,createElement:t=>{const el=new Element(t);el.document=document;return el;}};
  const $=s=>{if(!nodes.has(s))nodes.set(s,document.createElement('div'));return nodes.get(s);};
  const opener=document.createElement('button');opener.textContent='Cancel download';const original=document.createElement('div');original.append(opener);$('#picker-body').append(original);
  const d=dl('cancel-me');const context=vm.createContext({ $,document,Node:Element,transferOperations:new Map(),invalidateDownloadsRead(){},AbortSignal,libraryRefreshNeeded:false,state:{downloads:[d],view:'library',status:{downloads:true},dlScope:'mine'},api:async(path,options)=>{if(request)return request(path,options);if(failure)throw Error('Files are shared');return {};},jsonPost:body=>body,episodeLabel:()=>null,fmtBytes:n=>String(n),h:null,showSheet:()=>()=>{},pushOverlay:()=>calls.push('push'),closeTopOverlay:()=>calls.push('close'),drawTransferDetails:()=>calls.push('restore'),renderLibrary:()=>calls.push('library'),toast(){},setTimeout(){},opener,d });
  vm.runInContext(between('function h(', 'const ICONS ='),context);
  vm.runInContext(between('let managerView = null;','function openTransferDetails'),context);
  vm.runInContext(between('function openDeleteDownload','function updateDlCard'),context);
  vm.runInContext('managerView = { list: {}, suspended: false }; openDeleteDownload(d, opener)',context);
  return {context,calls,$,opener,original,run:code=>vm.runInContext(code,context)};
}
test('manager cancellation confirmation reuses one overlay and Keep it restores exact manager content and focus', () => {
  const h=managerHarness();assert.ok(h.$('#picker-body').childNodes.every(node=>node instanceof Element), 'native replaceChildren must receive no false/zero text children');assert.doesNotMatch(h.$('#picker-body').textContent,/false 0/);assert.equal(h.run('managerView.suspended'),true);assert.equal(h.calls.includes('push'),false);
  h.$('#picker-body').querySelector('.del-cancel').click();assert.equal(h.$('#picker-body').firstChild,h.original);assert.equal(h.run('managerView.suspended'),false);assert.equal(h.context.document.activeElement,h.opener);assert.equal(h.calls.includes('close'),false);
});
test('successful cancellation returns to the manager; server refusal retains confirmation and Keep it remains usable', async () => {
  let h=managerHarness();await h.$('#picker-body').querySelector('.del-confirm').click();assert.equal(h.context.state.downloads.length,0);assert.equal(h.$('#picker-body').firstChild,h.original);assert.equal(h.calls.includes('push'),false);assert.equal(h.calls.includes('close'),false);
  h=managerHarness({failure:true});await h.$('#picker-body').querySelector('.del-confirm').click();assert.match(h.$('#picker-body').textContent,/Files are shared/);assert.equal(h.$('#picker-body').querySelector('.del-cancel').disabled,false);h.$('#picker-body').querySelector('.del-cancel').click();assert.equal(h.$('#picker-body').firstChild,h.original);
});

test('transfer action restores accidental body focus without stealing a newer keyboard focus', async () => {
  const document={body:{},activeElement:null};let resolve;
  const opener={isConnected:true,hidden:false,disabled:false,focus(){document.activeElement=this;}},other={};document.activeElement=opener;
  let dropFocus=true;let pending=new Promise(r=>{resolve=r;});
  const context=vm.createContext({document,state:{downloads:[dl('focus')]},api:()=>pending,jsonPost:body=>body,invalidateDownloadsRead(){},patchTransferNodes(){},patchUnifiedLibrary(){if(dropFocus)document.activeElement=document.body;}});
  vm.runInContext(between('const transferOperations =','function openDeleteDownload'),context);
  let action=vm.runInContext("runTransferAction(state.downloads[0], 'pause')",context);resolve({});await action;assert.equal(document.activeElement,opener);
  pending=new Promise(r=>{resolve=r;});document.activeElement=opener;dropFocus=false;action=vm.runInContext("runTransferAction(state.downloads[0], 'resume')",context);document.activeElement=other;resolve({});await action;assert.equal(document.activeElement,other);
});

const deferredResponse = () => { let resolve; const promise=new Promise(r=>{resolve=r;}); return {promise,resolve}; };
function installDownloadsReads(h) { h.run(between('let downloadsRequest =','function makeDlCard(')); }
test('successful Pause, Resume and Retry reject pre-mutation snapshots and retain the fresh pending read', async () => {
  for (const [action, expected] of [['pause','pausedDL'],['resume','downloading'],['retry','checkingDL']]) {
    const old=deferredResponse(),fresh=deferredResponse();let reads=0;
    const h=managerHarness({request:async path=>path==='/api/downloads'?(++reads===1?old.promise:fresh.promise):{ok:true}});
    installDownloadsReads(h);h.context.patchTransferNodes=()=>{};h.context.patchUnifiedLibrary=()=>{};h.run(between('const transferOperations =','function openDeleteDownload'));
    h.context.document.activeElement=null;
    const stale=h.run('loadDownloads()');await h.run(`runTransferAction(state.downloads[0], '${action}')`);
    assert.equal(h.context.state.downloads[0].state,expected);
    const latest=h.run('loadDownloads()');assert.notEqual(latest,stale,'the old request must not remain cached after a mutation');
    old.resolve({items:[dl('cancel-me',{state:'stale-before-control'})]});await stale;
    assert.equal(h.context.state.downloads[0].state,expected,'late snapshot cannot undo successful control');
    assert.equal(h.run('loadDownloads()'),latest,'settling the old request cannot clear the newer request');
    fresh.resolve({items:[dl('cancel-me',{state:expected})]});await latest;assert.equal(reads,2);
  }
});
test('successful deletion rejects an older snapshot that would reinsert the removed transfer', async () => {
  const old=deferredResponse(),fresh=deferredResponse();let reads=0;
  const h=managerHarness({request:async path=>path==='/api/downloads'?(++reads===1?old.promise:fresh.promise):{ok:true}});
  installDownloadsReads(h);const stale=h.run('loadDownloads()');await h.$('#picker-body').querySelector('.del-confirm').click();
  assert.equal(h.context.state.downloads.length,0);const latest=h.run('loadDownloads()');assert.notEqual(latest,stale);
  old.resolve({items:[dl('cancel-me')]});await stale;assert.equal(h.context.state.downloads.length,0);
  assert.equal(h.run('loadDownloads()'),latest);fresh.resolve({items:[]});await latest;assert.equal(h.context.state.downloads.length,0);assert.equal(reads,2);
});
test('finished non-video downloads are complete and manageable without an endless preparation state', () => {
  const [entry]=libraryUnion([],[],[dl('archive',{done:true,hasVideo:false,ready:false,progress:1,tmdbId:null,mediaType:null,state:'stoppedUP'})]);
  assert.equal(entry.active.length,0);assert.equal(entry.ready,false);assert.equal(entry.state,'Complete');assert.equal(transferState(entry.transfers[0]),'Complete');assert.equal(libraryAvailability(entry),'No playable video');
  assert.equal(filterLibrary([entry],{availability:'downloading'}).length,0);assert.equal(filterLibrary([entry]).length,1);
});

test('a focused completed card keeps its grid position until the focusout removes it', () => {
  const h=harness();h.state.libAvailability='downloading';h.state.downloads.push(dl('before',{tmdbId:11,canonicalTitle:'0 first'}),dl('after',{tmdbId:12,canonicalTitle:'Z last'}));h.run('renderLibrary()');
  const list=h.$('#library-body').querySelector('.library-grid'),card=list.children[1];h.context.document.activeElement=card.querySelector('.title-card');
  h.state.library=[film];h.state.downloads[0]={...h.state.downloads[0],done:true,ready:true,progress:1};h.run('renderLibrary()');
  assert.equal(list.children[1],card);assert.equal(card.querySelector('.sub').textContent,'Ready to watch');
  h.context.document.activeElement={};h.run('renderLibrary()');assert.equal(list.children.includes(card),false);
});
