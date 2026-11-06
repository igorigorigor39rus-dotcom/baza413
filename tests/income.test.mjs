import test from 'node:test';
import assert from 'node:assert/strict';
import {dailyWallet,payoutText,formatDailyRate} from '../web/income.mjs';
const initial=()=>({balance:7,asOf:0,incomeCycleAt:0,pending:0});
test('100 m²: no credit before 24h, 10 bones exactly at boundary, replay no duplicate',()=>{
 const before=dailyWallet(initial(),100,86399);assert.equal(before.balance,7);
 const paid=dailyWallet(before,100,86400);assert.equal(paid.balance,17);assert.equal(paid.nextPayoutAt,172800);
 assert.equal(dailyWallet(paid,100,86400).balance,17);
 assert.equal(dailyWallet(paid,100,172800).balance,27);
});
test('ownership time: 100 m² for 8h then 50 m² for 16h gives 6⅔ bones',()=>{
 const part=dailyWallet(initial(),100,28800);assert.equal(part.balance,7);
 const paid=dailyWallet(part,50,86400);assert.ok(Math.abs(paid.balance-(7+20/3))<1e-10);
});
test('late capture and loss preserve partial daily reward without whole-day windfall',()=>{
 const idle=dailyWallet({balance:0,asOf:0,incomeCycleAt:null,pending:0},0,82800);
 const gained=dailyWallet(idle,100,86400);assert.equal(gained.balance,0);assert.equal(gained.nextPayoutAt,169200);
 const lost=dailyWallet(gained,0,169200);assert.ok(Math.abs(lost.balance-10/24)<1e-10);
});
test('offline many days, fractional land and pending reward stay precise',()=>{
 const w=dailyWallet(initial(),5,86400*3.5);assert.equal(w.balance,8.5);assert.equal(w.pending,.25);assert.equal(w.rate,.5);
 assert.equal(dailyWallet(w,5,86400*4).balance,9);
 assert.match(formatDailyRate(.5),/0,5/);assert.match(payoutText({nextPayoutAt:null}),/24 часа/);
});
