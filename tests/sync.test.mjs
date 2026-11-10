import test from 'node:test';
import assert from 'node:assert/strict';
import { createSync, mergeLive } from '../web/sync.mjs';
const flush = async () => { for (let i=0;i<30;i++) await Promise.resolve(); };
class Page extends EventTarget { hidden=false;defaultView=new EventTarget(); change(hidden) { this.hidden=hidden; this.dispatchEvent(new Event('visibilitychange')); } }
function clock() {
  let now=0,id=0; const jobs=new Map();
  return { setTimeout(fn,delay) { const n=++id; jobs.set(n,{fn,at:now+delay});return n; },clearTimeout(n) { jobs.delete(n); },
    async tick(ms) { const end=now+ms; await flush(); for (;;) { const entries=[...jobs].filter(([,j])=>j.at<=end).sort((a,b)=>a[1].at-b[1].at);if (!entries.length) break; const [n,j]=entries[0];jobs.delete(n);now=j.at;j.fn();await flush(); } now=end;await flush(); } };
}
const snapshot = (balance=1) => ({ wallet:{balance}, live:{walk:null}, notificationsKey:'a'.repeat(32) });
function fixture(api=async()=>snapshot()) {
  const page=new Page(),timers=clock(),received=[];let active=false;
  const sync=createSync({api,document:page,timers,enabled:()=>true,active:()=>active,apply:d=>received.push(d)});
  return {sync,page,timers,received,setActive:v=>active=v};
}
test('idle sends one shared request per minute; active keeps 10-second interval',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return snapshot();});await f.sync.start();
  await f.timers.tick(59000);assert.equal(calls,1);await f.timers.tick(1000);assert.equal(calls,2);
  f.setActive(true);await f.sync.refresh();await f.timers.tick(30000);assert.equal(calls,6);f.sync.stop();
});
test('a slow request never overlaps a timer or a burst of explicit refreshes',async()=>{
  let resolve,calls=0;const f=fixture(()=>{calls++;return calls===1?new Promise(r=>resolve=r):Promise.resolve(snapshot());});
  const first=f.sync.start();for(let i=0;i<10;i++)f.sync.refresh();await f.timers.tick(10000);assert.equal(calls,1);
  resolve(snapshot());await first;assert.equal(calls,1);f.sync.stop();
});
test('a snapshot begun before mutation never overwrites the new balance',async()=>{
  let resolve,calls=0;const f=fixture(()=>++calls===1?new Promise(r=>resolve=r):Promise.resolve(snapshot(25)));
  const pending=f.sync.start();f.sync.invalidate();const refreshed=f.sync.refresh();resolve(snapshot(100));
  await pending;await refreshed;assert.deepEqual(f.received.map(x=>x.wallet.balance),[25]);f.sync.stop();
});
test('hidden tab stops polling and restores state immediately on return',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return snapshot();});await f.sync.start();f.page.change(true);
  await f.timers.tick(600000);assert.equal(calls,1);f.page.change(false);await flush();assert.equal(calls,2);f.sync.stop();
});
test('GPS deltas reconstruct exactly; wrong offsets trigger one full resync',async()=>{
  const p={latitude:54,longitude:20};const a=mergeLive(null,{walk:{id:'one',offset:0,pointCount:1,reset:true,points:[p]}});
  const b=mergeLive(a.walk,{walk:{id:'one',offset:1,pointCount:2,reset:false,points:[p]}});assert.equal(b.walk.points.length,2);
  assert.throws(()=>mergeLive(b.walk,{walk:{id:'two',offset:1,pointCount:1,points:[]}}),/GPS_CURSOR/);
  let calls=0;const f=fixture(async()=>({live:{walk:++calls===1?{id:'one',offset:1,pointCount:1,points:[]}:{id:'one',reset:true,offset:0,pointCount:1,points:[p]}}}));
  await f.sync.start();assert.equal(calls,2);assert.equal(f.received[0].live.walk.points.length,1);f.sync.stop();
});
test('failed requests back off; actions can still request an immediate retry',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;if(calls===1)throw Error('offline');return snapshot();});
  await f.sync.start();await f.timers.tick(60000);assert.equal(calls,1);await f.sync.refresh();assert.equal(calls,2);f.sync.stop();
});
test('no pre-mutation snapshot is shown while a write is in progress',async()=>{
  let resolve,calls=0;const f=fixture(()=>++calls===1?new Promise(r=>resolve=r):Promise.resolve(snapshot(25)));
  const pending=f.sync.start();f.sync.beginMutation();resolve(snapshot(100));await pending;
  assert.equal(f.received.length,0);assert.equal(calls,1);
  f.sync.endMutation();await flush();assert.deepEqual(f.received.map(x=>x.wallet.balance),[25]);f.sync.stop();
});
test('network reconnect retries immediately without waiting for backoff',async()=>{
  let calls=0;const f=fixture(async()=>{if(++calls===1)throw Error('offline');return snapshot();});
  await f.sync.start();f.page.defaultView.dispatchEvent(new Event('online'));await flush();assert.equal(calls,2);f.sync.stop();
});
test('failure of an outdated channel does not cancel a queued channel switch', async () => {
  let reject, calls=0, room={channel:'district',generation:1};
  const page=new Page(),timers=clock(),received=[];
  const sync=createSync({document:page,timers,enabled:()=>true,active:()=>true,chatRequest:()=>room,
    api:()=>++calls===1?new Promise((_,r)=>reject=r):Promise.resolve(snapshot()),apply:(_,sent)=>received.push(sent.channel)});
  const first=sync.start();room={channel:'world',generation:2};sync.refresh();reject(Error('old request failed'));
  await first;assert.deepEqual(received,['world']);assert.equal(calls,2);sync.stop();
});
test('hiding during a request aborts and discards it, then foreground reloads', async () => {
  let calls=0,aborted=0;const page=new Page(),timers=clock(),received=[];
  const sync=createSync({document:page,timers,enabled:()=>true,active:()=>false,apply:d=>received.push(d.wallet.balance),
    api:(_,options)=>++calls===1?new Promise((_,reject)=>options.signal.addEventListener('abort',()=>{aborted++;reject(Error('aborted'));})):Promise.resolve(snapshot(25))});
  const pending=sync.start();page.change(true);await pending;assert.equal(aborted,1);assert.deepEqual(received,[]);
  page.change(false);await flush();assert.deepEqual(received,[25]);sync.stop();
});
