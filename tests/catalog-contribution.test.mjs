import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { wholeCents, contribution } from "../operations/catalog-math.mjs";
test("cents parser handles valid money, invalid and blanks",()=>{
 assert.equal(wholeCents("14.99"),1499);assert.equal(wholeCents("0"),0);
 for(const x of ["", "not a number", "-1", "Infinity", "1000001", null])assert.equal(wholeCents(x),null);
});
test("whole-cent profitability and exact loss",()=>{
 const p=contribution({price:1499,costs:[500,300,200,100,100,100],targetMargin:20});
 assert.equal(p.revenue,1499);assert.equal(p.cost,1300);assert.equal(p.profit,199);
 const q=contribution({price:1000,costs:[1500]});assert.equal(q.profit,-500);
});
test("zero-price products never divide by zero",()=>{
 const x=contribution({price:0,costs:[500]});assert.equal(x.revenue,0);assert.equal(x.margin,null);
});
test("catalog 10% discount uses rounded whole cents",()=>{
 const x=contribution({price:1999,costs:[1000],discountPercent:10,targetMargin:25});
 assert.equal(x.discount,200);assert.equal(x.revenue,1799);assert.equal(x.profit,799);
 assert(x.targetListPrice-Math.round(x.targetListPrice*0.1)>=Math.ceil(1000/0.75));
});
test("target and break-even prices cover costs under discount",()=>{
 const x=contribution({price:2000,costs:[300,500,100],discountPercent:10,targetMargin:25});
 const net=p=>p-Math.round(p*.1);
 assert(net(x.minimumListPrice)>=900);
 assert(net(x.targetListPrice)>=Math.ceil(900/.75));
 assert(x.minimumListPrice===0||net(x.minimumListPrice-1)<900);
 assert(x.targetListPrice===0||net(x.targetListPrice-1)<Math.ceil(900/.75));
});
test("rejects invalid numerical assumptions",()=>{
 assert.throws(()=>contribution({price:-1,costs:[100]}));
 assert.throws(()=>contribution({price:100,costs:[-1]}));
 assert.throws(()=>contribution({price:100,costs:[],discountPercent:100}));
 assert.throws(()=>contribution({price:100,costs:[],targetMargin:100}));
});
test("planner loads only the same-site catalog and local scripts",()=>{
 const html=readFileSync(new URL("../operations/catalog-contribution.html",import.meta.url),"utf8");
 const js=readFileSync(new URL("../operations/catalog-contribution.js",import.meta.url),"utf8");
 assert.match(html,/type="module" src="catalog-contribution.js"/);
 assert.match(js,/fetch\("\.\.\/data\/products\.json"/);
 assert.doesNotMatch(js,/(?:localStorage|sessionStorage|indexedDB|\.innerHTML\s*=)/);
 assert.match(html,/noindex,nofollow/);
});
test("rounded discount prices are the exact minimum over sample grid",()=>{
 for(let cost=0;cost<=10000;cost+=113){
  for(const discountPercent of [0,10,12,25,33]){
   const result=contribution({price:1999,costs:[cost],discountPercent,targetMargin:25});
   const net=p=>p-Math.round(p*discountPercent/100);
   const targetNet=Math.ceil(cost/0.75);
   assert(net(result.minimumListPrice)>=cost);
   assert(net(result.targetListPrice)>=targetNet);
   if(result.minimumListPrice>0)assert(net(result.minimumListPrice-1)<cost);
   if(result.targetListPrice>0)assert(net(result.targetListPrice-1)<targetNet);
  }
 }
});
